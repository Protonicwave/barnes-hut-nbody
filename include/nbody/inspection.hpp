#pragma once

#include <cstddef>
#include <vector>

#include "nbody/forces.hpp"
#include "nbody/particles.hpp"

namespace nbody {

// Cells are subdivided to at most this depth. The root has depth 0.
inline constexpr unsigned MAX_TREE_DEPTH = 21;

// Shallowest depth that `tree_cells` reports: the root and its octants hold
// every particle and say nothing about the structure.
inline constexpr unsigned MIN_REPORTED_DEPTH = 2;

// A cell of the octree: its box, and the mass and centre of mass of the
// particles inside it.
struct TreeCell {
    Vec3 centre;
    double size = 0.0;  // edge length
    unsigned depth = 0;
    double mass = 0.0;
    Vec3 centre_of_mass;
};

// The sources a force on one particle is summed from.
struct WalkTrace {
    std::vector<TreeCell> accepted;  // cells summed as one source
    std::vector<TreeCell> opened;    // cells visited and not accepted, leaves included
    // Particles summed one by one, in the caller's order of indices. Never
    // includes the particle itself.
    std::vector<std::size_t> particles;

    [[nodiscard]] std::size_t interaction_count() const { return accepted.size() + particles.size(); }
};

// Copies of the tree's cells from depth MIN_REPORTED_DEPTH to max_depth,
// outermost first, for the tree that `compute_accelerations` builds on the
// same particles. Throws std::invalid_argument unless max_depth is from
// MIN_REPORTED_DEPTH to MAX_TREE_DEPTH. Empty for an empty particle set.
std::vector<TreeCell> tree_cells(const ParticleSet& particles, unsigned max_depth);

// The cells and particles summed for the particle at the given index, by the
// tree walk at config.theta. Only the opening angle is read from the
// configuration. Throws std::invalid_argument for a theta outside [0, 1] or
// an index at or above the particle count.
WalkTrace tree_walk_trace(const ParticleSet& particles, const ForceConfig& config,
                          std::size_t index);

// How far the configured method's accelerations are from direct summation's.
struct ForceComparison {
    // Quantiles of |a - a_direct| / |a_direct| over the particles. Particles
    // whose direct acceleration is zero have no relative error and are left
    // out; both are zero when none remain.
    double median_error = 0.0;
    double p99_error = 0.0;
    // Sources summed per particle: N - 1 for direct summation.
    double mean_interactions = 0.0;
};

// Evaluates both methods on the particles, with the configured softening and
// thread count. Throws std::invalid_argument for an invalid configuration.
ForceComparison force_comparison(const ParticleSet& particles, const ForceConfig& config);

}  // namespace nbody
