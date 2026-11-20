#pragma once

#include <cstddef>
#include <span>
#include <vector>

#include "nbody/vec3.hpp"

namespace nbody {

// Upper bound on the particle count, so sizes stay far from index overflow
// and a malformed request cannot ask for unbounded memory.
inline constexpr std::size_t MAX_PARTICLES = std::size_t{1} << 22;

// Positions, velocities and masses of N bodies. The size is fixed at
// construction and every value is finite, so inward code does not re-check.
class ParticleSet {
public:
    // Throws std::invalid_argument naming the value and its bound when the
    // sizes differ, N exceeds MAX_PARTICLES, a mass is not positive and
    // finite, or a position or velocity is not finite.
    ParticleSet(std::vector<Vec3> positions, std::vector<Vec3> velocities,
                std::vector<double> masses);

    std::size_t size() const { return masses_.size(); }

    std::span<const Vec3> positions() const { return positions_; }
    std::span<const Vec3> velocities() const { return velocities_; }
    std::span<const double> masses() const { return masses_; }

    // Writable views for integrators. Values written must stay finite.
    std::span<Vec3> positions() { return positions_; }
    std::span<Vec3> velocities() { return velocities_; }

private:
    std::vector<Vec3> positions_;
    std::vector<Vec3> velocities_;
    std::vector<double> masses_;
};

}  // namespace nbody
