#include <cmath>
#include <format>
#include <stdexcept>

#include "nbody/forces.hpp"

namespace nbody {

void check_softening(double softening) {
    if (!std::isfinite(softening) || softening < 0.0) {
        throw std::invalid_argument(
            std::format("softening must be finite and not negative, got {}", softening));
    }
}

std::vector<Vec3> compute_accelerations(const ParticleSet& particles, const ForceConfig& config) {
    check_softening(config.softening);
    const auto positions = particles.positions();
    const auto masses = particles.masses();
    const double softening_squared = config.softening * config.softening;
    std::vector<Vec3> accelerations(particles.size());
    for (std::size_t i = 0; i < particles.size(); ++i) {
        Vec3 sum;
        for (std::size_t j = 0; j < particles.size(); ++j) {
            if (j == i) {
                continue;
            }
            const Vec3 offset = positions[j] - positions[i];
            const double distance_squared = dot(offset, offset) + softening_squared;
            sum += (masses[j] / (distance_squared * std::sqrt(distance_squared))) * offset;
        }
        accelerations[i] = sum;
    }
    return accelerations;
}

}  // namespace nbody
