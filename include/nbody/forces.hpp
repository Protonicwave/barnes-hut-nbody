#pragma once

#include <vector>

#include "nbody/particles.hpp"

namespace nbody {

enum class ForceMethod {
    direct,  // every pair, O(N^2)
    tree,    // Barnes-Hut octree with monopole cells, O(N log N)
};

// Most threads a force evaluation or energy sum may use.
inline constexpr unsigned MAX_THREADS = 256;

// Gravitational constant is 1: lengths, masses and times are in N-body units.
struct ForceConfig {
    // Plummer softening length, zero or more.
    double softening = 0.0;
    ForceMethod method = ForceMethod::direct;
    // Opening angle of the tree method, from 0 (every cell opened, exact) to
    // 1. Larger values are not offered: a cell containing the particle could
    // then be accepted as a single source. Checked for every method.
    double theta = 0.5;
    // Threads used by the force loops, from 1 to MAX_THREADS. The result is
    // bitwise identical for every value: each acceleration is computed by one
    // thread, with no reduction across threads.
    unsigned thread_count = 1;
};

// Throws std::invalid_argument unless the softening is finite and not negative.
void check_softening(double softening);

// Throws std::invalid_argument unless the count is from 1 to MAX_THREADS.
void check_thread_count(unsigned thread_count);

// Acceleration of every particle from every other, in the order of the
// particle set, by the configured method with Plummer softening. Throws
// std::invalid_argument for an invalid configuration. Coincident particles
// with zero softening, and positions so large that a difference overflows,
// give non-finite values.
std::vector<Vec3> compute_accelerations(const ParticleSet& particles, const ForceConfig& config);

}  // namespace nbody
