#include "nbody/particles.hpp"

#include <cmath>
#include <format>
#include <stdexcept>
#include <utility>

namespace nbody {

namespace {

void check_sizes(std::size_t positions, std::size_t velocities, std::size_t masses) {
    if (positions > MAX_PARTICLES) {
        throw std::invalid_argument(
            std::format("particle count {} exceeds the maximum {}", positions, MAX_PARTICLES));
    }
    if (velocities != positions || masses != positions) {
        throw std::invalid_argument(std::format(
            "positions, velocities and masses must have equal sizes, got {}, {} and {}", positions,
            velocities, masses));
    }
}

}  // namespace

ParticleSet::ParticleSet(std::vector<Vec3> positions, std::vector<Vec3> velocities,
                         std::vector<double> masses)
    : positions_(std::move(positions)),
      velocities_(std::move(velocities)),
      masses_(std::move(masses)) {
    check_sizes(positions_.size(), velocities_.size(), masses_.size());
    for (std::size_t i = 0; i < masses_.size(); ++i) {
        if (!std::isfinite(masses_[i]) || masses_[i] <= 0.0) {
            throw std::invalid_argument(
                std::format("mass of particle {} must be positive and finite, got {}", i,
                            masses_[i]));
        }
        if (!is_finite(positions_[i])) {
            throw std::invalid_argument(
                std::format("position of particle {} must be finite, got ({}, {}, {})", i,
                            positions_[i].x, positions_[i].y, positions_[i].z));
        }
        if (!is_finite(velocities_[i])) {
            throw std::invalid_argument(
                std::format("velocity of particle {} must be finite, got ({}, {}, {})", i,
                            velocities_[i].x, velocities_[i].y, velocities_[i].z));
        }
    }
}

}  // namespace nbody
