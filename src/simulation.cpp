#include "nbody/simulation.hpp"

#include <cmath>
#include <format>
#include <stdexcept>
#include <utility>

namespace nbody {

namespace {

void check_timestep(double timestep) {
    if (!std::isfinite(timestep) || timestep <= 0.0) {
        throw std::invalid_argument(
            std::format("timestep must be finite and positive, got {}", timestep));
    }
}

}  // namespace

Simulation::Simulation(ParticleSet particles, ForceConfig config, double timestep)
    : particles_(std::move(particles)), config_(config), timestep_(timestep) {
    check_timestep(timestep_);
    accelerations_ = compute_accelerations(particles_, config_);
}

void Simulation::step(std::size_t count) {
    if (particles_.size() == 0) {
        return;
    }
    const double half_step = 0.5 * timestep_;
    const auto velocities = particles_.velocities();
    const auto positions = particles_.positions();
    for (std::size_t s = 0; s < count; ++s) {
        for (std::size_t i = 0; i < particles_.size(); ++i) {
            velocities[i] += half_step * accelerations_[i];
            positions[i] += timestep_ * velocities[i];
            if (!is_finite(positions[i])) {
                throw std::runtime_error(
                    std::format("position of particle {} became non-finite at step {}", i,
                                steps_taken_ + 1));
            }
        }
        accelerations_ = compute_accelerations(particles_, config_);
        for (std::size_t i = 0; i < particles_.size(); ++i) {
            velocities[i] += half_step * accelerations_[i];
            if (!is_finite(velocities[i])) {
                throw std::runtime_error(
                    std::format("velocity of particle {} became non-finite at step {}", i,
                                steps_taken_ + 1));
            }
        }
        ++steps_taken_;
    }
}

}  // namespace nbody
