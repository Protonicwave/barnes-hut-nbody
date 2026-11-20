#pragma once

#include <cmath>
#include <vector>

#include "nbody/particles.hpp"

namespace nbody {

// Acceleration of a particle from a source of the given mass at the given
// offset from it, with Plummer softening.
inline Vec3 pair_acceleration(const Vec3& offset, double source_mass, double softening_squared) {
    const double distance_squared = dot(offset, offset) + softening_squared;
    return (source_mass / (distance_squared * std::sqrt(distance_squared))) * offset;
}

// Both take the configuration already validated, and return accelerations in
// the order of the particle set.
std::vector<Vec3> direct_accelerations(const ParticleSet& particles, double softening_squared);
std::vector<Vec3> tree_accelerations(const ParticleSet& particles, double softening_squared,
                                     double theta);

}  // namespace nbody
