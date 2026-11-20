#pragma once

#include "nbody/particles.hpp"
#include "nbody/vec3.hpp"

namespace nbody {

double kinetic_energy(const ParticleSet& particles);

// Softened pair sum of -m_i m_j / sqrt(r^2 + softening^2). Throws
// std::invalid_argument for an invalid softening.
double potential_energy(const ParticleSet& particles, double softening);

Vec3 total_momentum(const ParticleSet& particles);

// Mass-weighted mean position, the origin for an empty set.
Vec3 centre_of_mass(const ParticleSet& particles);

}  // namespace nbody
