#pragma once

#include <cstddef>
#include <vector>

#include "nbody/forces.hpp"
#include "nbody/particles.hpp"

namespace nbody {

// Kick-drift-kick leapfrog with a fixed timestep.
class Simulation {
public:
    // Throws std::invalid_argument unless the timestep is finite and positive,
    // or when the force configuration is invalid.
    Simulation(ParticleSet particles, ForceConfig config, double timestep);

    // Advances by count steps. Does nothing for an empty particle set. Throws
    // std::runtime_error naming the particle and step when a position becomes
    // non-finite; the state is then unspecified.
    void step(std::size_t count);

    const ParticleSet& particles() const { return particles_; }
    double time() const { return static_cast<double>(steps_taken_) * timestep_; }

private:
    ParticleSet particles_;
    ForceConfig config_;
    double timestep_;
    std::size_t steps_taken_ = 0;
    std::vector<Vec3> accelerations_;
};

}  // namespace nbody
