#pragma once

#include <cstddef>
#include <cstdint>

#include "nbody/particles.hpp"

namespace nbody {

// Plummer sphere in virial units: total mass 1, G = 1, total energy -1/4, so
// the scale radius is 3 pi / 16. Positions and velocities follow Aarseth,
// Henon and Wielen (1974), shifted to zero centre of mass and momentum. The
// same seed gives the same set on one platform and standard library; other
// platforms may differ in the last bits, because the libm functions used are not
// correctly rounded. Throws std::invalid_argument
// when count is above MAX_PARTICLES.
ParticleSet plummer_sphere(std::size_t count, std::uint64_t seed);

// Cold uniform sphere of radius 1, total mass 1, at rest: the collapse case.
// Throws std::invalid_argument when count is above MAX_PARTICLES.
ParticleSet uniform_sphere(std::size_t count, std::uint64_t seed);

// Two equal masses, total mass 1, centre of mass at rest at the origin,
// starting at apoapsis in the x-y plane. Throws std::invalid_argument unless
// 0 <= eccentricity < 1 and the semi-major axis is finite and positive.
ParticleSet kepler_binary(double eccentricity, double semi_major_axis);

}  // namespace nbody
