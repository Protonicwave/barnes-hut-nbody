#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <format>
#include <limits>
#include <numeric>
#include <stdexcept>
#include <span>
#include <utility>
#include <vector>

#include "force_kernels.hpp"
#include "nbody/inspection.hpp"
#include "parallel.hpp"

namespace nbody {

namespace {

// Cells are subdivided to at most this depth, so a Morton key of three bits
// per level fits in 63 bits.
constexpr unsigned MAX_DEPTH = MAX_TREE_DEPTH;
constexpr double CELLS_PER_AXIS = static_cast<double>(std::uint64_t{1} << MAX_DEPTH);
constexpr double LAST_CELL_COORDINATE = CELLS_PER_AXIS - 1.0;

// Cells holding at most this many particles are not subdivided.
constexpr std::size_t LEAF_CAPACITY = 4;

// A walk pops one cell and pushes at most eight, so the stack holds at most
// 7 * MAX_DEPTH + 1 entries, within this capacity.
// Node and particle indices are 32-bit: a tree has at most MAX_DEPTH + 1 cells
// per particle.
constexpr std::size_t WALK_STACK_CAPACITY = std::size_t{8} * MAX_DEPTH;

static_assert(MAX_PARTICLES * (MAX_DEPTH + 1) <= std::numeric_limits<std::uint32_t>::max(),
              "cell and particle indices must fit in 32 bits");

struct Node {
    Vec3 centre_of_mass;
    Vec3 centre;  // geometric centre of the cell
    double mass = 0.0;
    double size = 0.0;           // edge length
    double centre_offset = 0.0;  // distance from the geometric centre to the centre of mass
    std::uint32_t first = 0;     // first particle, in tree order
    std::uint32_t count = 0;
    std::uint32_t first_child = 0;
    std::uint8_t child_count = 0;  // zero for a leaf
    std::uint8_t depth = 0;
};

TreeCell to_cell(const Node& node) {
    return {node.centre, node.size, node.depth, node.mass, node.centre_of_mass};
}

// Spreads the low 21 bits of a value so two zero bits follow each bit.
constexpr std::uint64_t spread_bits(std::uint64_t value) {
    value &= 0x1fffff;
    value = (value | value << 32) & 0x1f00000000ffff;
    value = (value | value << 16) & 0x1f0000ff0000ff;
    value = (value | value << 8) & 0x100f00f00f00f00f;
    value = (value | value << 4) & 0x10c30c30c30c30c3;
    value = (value | value << 2) & 0x1249249249249249;
    return value;
}

// The cubic region the keys are measured in: its lowest corner and edge.
struct Box {
    Vec3 origin;
    double edge = 0.0;
};

Box bounding_cube(std::span<const Vec3> positions) {
    Vec3 low = positions[0];
    Vec3 high = positions[0];
    for (const Vec3& p : positions) {
        low = {std::min(low.x, p.x), std::min(low.y, p.y), std::min(low.z, p.z)};
        high = {std::max(high.x, p.x), std::max(high.y, p.y), std::max(high.z, p.z)};
    }
    const Vec3 extent = high - low;
    return {low, std::max({extent.x, extent.y, extent.z})};
}

std::uint64_t morton_key(const Vec3& position, const Box& box, double scale) {
    const auto cell = [scale](double offset) {
        // The upper face of the box maps to one past the last cell.
        return static_cast<std::uint64_t>(std::min(offset * scale, LAST_CELL_COORDINATE));
    };
    const Vec3 offset = position - box.origin;
    return spread_bits(cell(offset.x)) | spread_bits(cell(offset.y)) << 1 |
           spread_bits(cell(offset.z)) << 2;
}

// Centre of the child of a cell in the given octant: bit 0 selects the upper
// half in x, bit 1 in y and bit 2 in z, as in the Morton key.
Vec3 child_centre(const Node& parent, std::uint64_t octant) {
    const double quarter = 0.25 * parent.size;
    const auto shift = [&](std::uint64_t bit) { return (octant & bit) != 0 ? quarter : -quarter; };
    return parent.centre + Vec3{shift(1U), shift(2U), shift(4U)};
}

class Octree {
public:
    // Requires at least one particle.
    explicit Octree(const ParticleSet& particles);

    // Acceleration of the particle at the given index in tree order.
    [[nodiscard]] Vec3 acceleration_on(std::size_t index, double softening_squared, double theta) const;

    // Index in the caller's order of the particle at the given tree-order index.
    [[nodiscard]] std::uint32_t original_index(std::size_t index) const { return original_index_[index]; }

    // Position and mass of the particle at the given tree-order index.
    [[nodiscard]] const Vec3& particle_position(std::size_t index) const { return positions_[index]; }
    [[nodiscard]] double particle_mass(std::size_t index) const { return masses_[index]; }

    // Number of sources the force on the particle at the given tree-order
    // index is summed from: accepted cells plus individual particles.
    [[nodiscard]] std::uint32_t interaction_count(std::size_t index, double theta) const;

    // Cells from depth 2 to max_depth, outermost first.
    [[nodiscard]] std::vector<TreeCell> cells_to_depth(unsigned max_depth) const;

    // The walk for the particle at the given index in the caller's order.
    [[nodiscard]] WalkTrace trace(std::size_t original, double theta) const;

private:
    // Returns the Morton key of each particle, in tree order.
    std::vector<std::uint64_t> sort_particles(const ParticleSet& particles, const Box& box);
    void subdivide(const std::vector<std::uint64_t>& keys);
    void accumulate_mass();

    // Visits the sources of the force on the particle at the given tree-order
    // index. Calls visitor.open(node) for each cell that is not accepted,
    // visitor.accept(node) for each cell summed as one source and
    // visitor.visit(k) for each other particle in an opened leaf, k being its
    // tree-order index.
    template <typename Visitor>
    void walk(std::size_t index, double theta, Visitor& visitor) const;

    template <typename Visitor>
    static void notify_open(Visitor& visitor, const Node& node) {
        if constexpr (requires { visitor.open(node); }) {
            visitor.open(node);
        }
    }

    // Visits the particles of a leaf other than the one at the given index.
    template <typename Visitor>
    static void visit_leaf(const Node& leaf, std::size_t index, Visitor& visitor) {
        for (std::size_t k = leaf.first; k < leaf.first + leaf.count; ++k) {
            if (k != index) {
                visitor.visit(k);
            }
        }
    }

    std::vector<Node> nodes_;
    std::vector<Vec3> positions_;
    std::vector<double> masses_;
    std::vector<std::uint32_t> original_index_;
};

Octree::Octree(const ParticleSet& particles) {
    const Box box = bounding_cube(particles.positions());
    const std::vector<std::uint64_t> keys = sort_particles(particles, box);
    Node root;
    root.centre = box.origin + (0.5 * box.edge) * Vec3{1.0, 1.0, 1.0};
    root.size = box.edge;
    root.count = static_cast<std::uint32_t>(particles.size());
    nodes_.push_back(root);
    subdivide(keys);
    accumulate_mass();
}

std::vector<std::uint64_t> Octree::sort_particles(const ParticleSet& particles, const Box& box) {
    const std::size_t count = particles.size();
    // A zero or overflowing extent, or one so small that the scale overflows,
    // gives every particle key 0, so the tree is one deep chain and every
    // pair is summed individually or as a cell far from the particle.
    const double scale = CELLS_PER_AXIS / box.edge;
    const bool scale_is_usable = scale > 0.0 && std::isfinite(scale);
    std::vector<std::pair<std::uint64_t, std::uint32_t>> keyed(count);
    for (std::size_t i = 0; i < count; ++i) {
        const std::uint64_t key =
            scale_is_usable ? morton_key(particles.positions()[i], box, scale) : 0;
        keyed[i] = {key, static_cast<std::uint32_t>(i)};
    }
    // Ties break on the original index, so the order is the same everywhere.
    std::ranges::sort(keyed);
    original_index_.reserve(count);
    positions_.reserve(count);
    masses_.reserve(count);
    std::vector<std::uint64_t> keys;
    keys.reserve(count);
    for (const auto& [key, index] : keyed) {
        keys.push_back(key);
        original_index_.push_back(index);
        positions_.push_back(particles.positions()[index]);
        masses_.push_back(particles.masses()[index]);
    }
    return keys;
}

// Builds level by level, so the children of a cell are contiguous and always
// come after it.
void Octree::subdivide(const std::vector<std::uint64_t>& keys) {
    for (std::size_t n = 0; n < nodes_.size(); ++n) {
        // A copy: the pushes below can reallocate nodes_.
        const Node parent = nodes_[n];
        if (parent.count <= LEAF_CAPACITY || parent.depth == MAX_DEPTH) {
            continue;
        }
        const unsigned shift = 3 * (MAX_DEPTH - 1 - parent.depth);
        const auto octant = [&](std::size_t k) { return (keys[k] >> shift) & 7U; };
        const std::size_t first_child = nodes_.size();
        const std::size_t end = static_cast<std::size_t>(parent.first) + parent.count;
        for (std::size_t begin = parent.first; begin < end;) {
            const std::uint64_t child_octant = octant(begin);
            std::size_t child_end = begin + 1;
            while (child_end < end && octant(child_end) == child_octant) {
                ++child_end;
            }
            Node child;
            child.centre = child_centre(parent, child_octant);
            child.size = 0.5 * parent.size;
            child.first = static_cast<std::uint32_t>(begin);
            child.count = static_cast<std::uint32_t>(child_end - begin);
            child.depth = static_cast<std::uint8_t>(parent.depth + 1);
            nodes_.push_back(child);
            begin = child_end;
        }
        nodes_[n].first_child = static_cast<std::uint32_t>(first_child);
        nodes_[n].child_count = static_cast<std::uint8_t>(nodes_.size() - first_child);
    }
}

// Children come after their parent, so a reverse pass sees them first.
void Octree::accumulate_mass() {
    for (std::size_t n = nodes_.size(); n-- > 0;) {
        Node& node = nodes_[n];
        double mass = 0.0;
        Vec3 moment;
        if (node.child_count == 0) {
            for (std::size_t k = node.first; k < node.first + node.count; ++k) {
                mass += masses_[k];
                moment += masses_[k] * positions_[k];
            }
        } else {
            for (std::size_t c = node.first_child; c < node.first_child + node.child_count; ++c) {
                mass += nodes_[c].mass;
                moment += nodes_[c].mass * nodes_[c].centre_of_mass;
            }
        }
        node.mass = mass;
        node.centre_of_mass = (1.0 / mass) * moment;
        const Vec3 away = node.centre_of_mass - node.centre;
        node.centre_offset = std::sqrt(dot(away, away));
    }
}

// A cell is summed as one source when its centre of mass is further than
// size / theta + centre_offset from the particle (Barnes 1994). Written
// without the division so theta = 0 never accepts a cell. A cell holding the
// particle is never far enough for theta up to 1, because the centre of mass
// and the particle are both inside it. Non-finite geometry compares false and
// opens the cell.
template <typename Visitor>
void Octree::walk(std::size_t index, double theta, Visitor& visitor) const {
    const Vec3 position = positions_[index];
    std::array<std::uint32_t, WALK_STACK_CAPACITY> stack{};
    std::size_t depth = 0;
    stack.at(depth++) = 0;
    while (depth > 0) {
        const Node& node = nodes_[stack.at(--depth)];
        if (node.child_count == 0) {
            notify_open(visitor, node);
            visit_leaf(node, index, visitor);
            continue;
        }
        const Vec3 offset = node.centre_of_mass - position;
        const double reach = node.size + theta * node.centre_offset;
        if (dot(offset, offset) * theta * theta > reach * reach) {
            visitor.accept(node);
            continue;
        }
        notify_open(visitor, node);
        for (std::size_t c = 0; c < node.child_count; ++c) {
            stack.at(depth++) = static_cast<std::uint32_t>(node.first_child + c);
        }
    }
}

// Walk visitors. A visitor has accept(node) for a cell summed as one source
// and visit(k) for a particle summed alone, and may add open(node), called
// for every cell that is not accepted, leaves included.
class ForceSum {
public:
    ForceSum(const Octree& tree, std::size_t index, double softening_squared)
        : tree_(&tree), position_(tree.particle_position(index)),
          softening_squared_(softening_squared) {}

    void accept(const Node& node) {
        sum_ += pair_acceleration(node.centre_of_mass - position_, node.mass, softening_squared_);
    }
    void visit(std::size_t k) {
        sum_ += pair_acceleration(tree_->particle_position(k) - position_, tree_->particle_mass(k),
                                  softening_squared_);
    }
    [[nodiscard]] const Vec3& sum() const { return sum_; }

private:
    const Octree* tree_;
    Vec3 position_;
    double softening_squared_;
    Vec3 sum_;
};

class InteractionCount {
public:
    void accept(const Node&) { ++count_; }
    void visit(std::size_t) { ++count_; }
    [[nodiscard]] std::uint32_t count() const { return count_; }

private:
    std::uint32_t count_ = 0;
};

class TraceRecorder {
public:
    explicit TraceRecorder(const Octree& tree) : tree_(&tree) {}

    void accept(const Node& node) { trace_.accepted.push_back(to_cell(node)); }
    void open(const Node& node) { trace_.opened.push_back(to_cell(node)); }
    void visit(std::size_t k) { trace_.particles.push_back(tree_->original_index(k)); }
    WalkTrace take() { return std::move(trace_); }

private:
    const Octree* tree_;
    WalkTrace trace_;
};

Vec3 Octree::acceleration_on(std::size_t index, double softening_squared, double theta) const {
    ForceSum visitor(*this, index, softening_squared);
    walk(index, theta, visitor);
    return visitor.sum();
}

std::uint32_t Octree::interaction_count(std::size_t index, double theta) const {
    InteractionCount visitor;
    walk(index, theta, visitor);
    return visitor.count();
}

std::vector<TreeCell> Octree::cells_to_depth(unsigned max_depth) const {
    std::vector<TreeCell> cells;
    for (const Node& node : nodes_) {
        if (node.depth >= MIN_REPORTED_DEPTH && node.depth <= max_depth) {
            cells.push_back(to_cell(node));
        }
    }
    return cells;
}

WalkTrace Octree::trace(std::size_t original, double theta) const {
    const auto found = std::ranges::find(original_index_, original);
    TraceRecorder recorder(*this);
    walk(static_cast<std::size_t>(found - original_index_.begin()), theta, recorder);
    return recorder.take();
}

}  // namespace

std::vector<Vec3> tree_accelerations(const ParticleSet& particles, double softening_squared,
                                     double theta, unsigned thread_count) {
    if (particles.size() == 0) {
        return {};
    }
    const Octree tree(particles);
    std::vector<Vec3> accelerations(particles.size());
    parallel_for(particles.size(), thread_count, [&](std::size_t k) {
        accelerations[tree.original_index(k)] = tree.acceleration_on(k, softening_squared, theta);
    });
    return accelerations;
}

std::uint64_t tree_interaction_count(const ParticleSet& particles, double theta,
                                     unsigned thread_count) {
    const Octree tree(particles);
    std::vector<std::uint32_t> counts(particles.size());
    parallel_for(particles.size(), thread_count,
                 [&](std::size_t k) { counts[k] = tree.interaction_count(k, theta); });
    return std::accumulate(counts.begin(), counts.end(), std::uint64_t{0});
}

std::vector<TreeCell> tree_cells(const ParticleSet& particles, unsigned max_depth) {
    if (max_depth < MIN_REPORTED_DEPTH || max_depth > MAX_TREE_DEPTH) {
        throw std::invalid_argument(std::format("max depth must be from {} to {}, got {}",
                                                MIN_REPORTED_DEPTH, MAX_TREE_DEPTH, max_depth));
    }
    if (particles.size() == 0) {
        return {};
    }
    return Octree(particles).cells_to_depth(max_depth);
}

WalkTrace tree_walk_trace(const ParticleSet& particles, const ForceConfig& config,
                          std::size_t index) {
    check_theta(config.theta);
    if (index >= particles.size()) {
        throw std::invalid_argument(
            std::format("particle index must be below {}, got {}", particles.size(), index));
    }
    return Octree(particles).trace(index, config.theta);
}

}  // namespace nbody
