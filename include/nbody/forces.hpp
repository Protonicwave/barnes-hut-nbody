#pragma once

#include <vector>

#include "nbody/particles.hpp"

namespace nbody {

// Gravitational constant is 1: lengths, masses and times are in N-body units.
struct ForceConfig {
    // Plummer softening length, zero or more.
    double softening = 0.0;
};

// Throws std::invalid_argument unless the softening is finite and not negative.
void check_softening(double softening);

// Acceleration of every particle from every other by direct summation with
// Plummer softening, in the order of the particle set. Throws
// std::invalid_argument for an invalid configuration. Coincident particles
// with zero softening, and positions so large that a difference overflows,
// give non-finite values.
std::vector<Vec3> compute_accelerations(const ParticleSet& particles, const ForceConfig& config);

}  // namespace nbody
