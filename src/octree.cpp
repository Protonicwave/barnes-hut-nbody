#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <span>
#include <utility>
#include <vector>

#include "force_kernels.hpp"

namespace nbody {

namespace {

// Cells are subdivided to at most this depth, so a Morton key of three bits
// per level fits in 63 bits.
constexpr unsigned MAX_DEPTH = 21;
constexpr double CELLS_PER_AXIS = 2097152.0;  // 2^MAX_DEPTH
constexpr double LAST_CELL_COORDINATE = CELLS_PER_AXIS - 1.0;

// Cells holding at most this many particles are not subdivided.
constexpr std::size_t LEAF_CAPACITY = 8;

// A walk pops one cell and pushes at most eight, so the stack holds at most
// 7 * MAX_DEPTH + 1 entries.
constexpr std::size_t WALK_STACK_CAPACITY = std::size_t{8} * MAX_DEPTH;

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

    // Acceleration of the particle at the given position in tree order.
    [[nodiscard]] Vec3 acceleration_on(std::size_t index, double softening_squared, double theta) const;

    // Position of the tree-order particle in the caller's order.
    [[nodiscard]] std::uint32_t original_index(std::size_t index) const { return original_index_[index]; }

private:
    void sort_particles(const ParticleSet& particles, const Box& box);
    void subdivide();
    void accumulate_mass();

    std::vector<Node> nodes_;
    std::vector<Vec3> positions_;
    std::vector<double> masses_;
    std::vector<std::uint64_t> keys_;
    std::vector<std::uint32_t> original_index_;
};

Octree::Octree(const ParticleSet& particles) {
    const Box box = bounding_cube(particles.positions());
    sort_particles(particles, box);
    Node root;
    root.centre = box.origin + (0.5 * box.edge) * Vec3{1.0, 1.0, 1.0};
    root.size = box.edge;
    root.count = static_cast<std::uint32_t>(particles.size());
    nodes_.push_back(root);
    subdivide();
    accumulate_mass();
}

void Octree::sort_particles(const ParticleSet& particles, const Box& box) {
    const std::size_t count = particles.size();
    // Zero or overflowing extent, or one so small the scale overflows: every
    // particle shares a cell and the tree degenerates to one deep chain.
    const double scale = CELLS_PER_AXIS / box.edge;
    const bool has_scale = scale > 0.0 && std::isfinite(scale);
    std::vector<std::pair<std::uint64_t, std::uint32_t>> keyed(count);
    for (std::size_t i = 0; i < count; ++i) {
        const std::uint64_t key = has_scale ? morton_key(particles.positions()[i], box, scale) : 0;
        keyed[i] = {key, static_cast<std::uint32_t>(i)};
    }
    // Ties break on the original index, so the order is the same everywhere.
    std::ranges::sort(keyed);
    keys_.reserve(count);
    original_index_.reserve(count);
    positions_.reserve(count);
    masses_.reserve(count);
    for (const auto& [key, index] : keyed) {
        keys_.push_back(key);
        original_index_.push_back(index);
        positions_.push_back(particles.positions()[index]);
        masses_.push_back(particles.masses()[index]);
    }
}

// Builds level by level, so the children of a cell are contiguous and always
// come after it.
void Octree::subdivide() {
    for (std::size_t n = 0; n < nodes_.size(); ++n) {
        const Node parent = nodes_[n];
        if (parent.count <= LEAF_CAPACITY || parent.depth == MAX_DEPTH) {
            continue;
        }
        const unsigned shift = 3 * (MAX_DEPTH - 1 - parent.depth);
        const auto octant = [&](std::size_t k) { return (keys_[k] >> shift) & 7U; };
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
Vec3 Octree::acceleration_on(std::size_t index, double softening_squared, double theta) const {
    const Vec3 position = positions_[index];
    std::array<std::uint32_t, WALK_STACK_CAPACITY> stack{};
    std::size_t depth = 0;
    stack.at(depth++) = 0;
    Vec3 sum;
    while (depth > 0) {
        const Node& node = nodes_[stack.at(--depth)];
        if (node.child_count == 0) {
            for (std::size_t k = node.first; k < node.first + node.count; ++k) {
                if (k != index) {
                    sum += pair_acceleration(positions_[k] - position, masses_[k],
                                             softening_squared);
                }
            }
            continue;
        }
        const Vec3 offset = node.centre_of_mass - position;
        const double reach = node.size + theta * node.centre_offset;
        if (dot(offset, offset) * theta * theta > reach * reach) {
            sum += pair_acceleration(offset, node.mass, softening_squared);
            continue;
        }
        assert(depth + node.child_count <= WALK_STACK_CAPACITY);
        for (std::size_t c = 0; c < node.child_count; ++c) {
            stack.at(depth++) = static_cast<std::uint32_t>(node.first_child + c);
        }
    }
    return sum;
}

}  // namespace

std::vector<Vec3> tree_accelerations(const ParticleSet& particles, double softening_squared,
                                     double theta) {
    if (particles.size() == 0) {
        return {};
    }
    const Octree tree(particles);
    std::vector<Vec3> accelerations(particles.size());
    for (std::size_t k = 0; k < particles.size(); ++k) {
        accelerations[tree.original_index(k)] = tree.acceleration_on(k, softening_squared, theta);
    }
    return accelerations;
}

}  // namespace nbody
