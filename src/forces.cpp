#include "nbody/forces.hpp"

#include <cmath>
#include <format>
#include <stdexcept>

#include "force_kernels.hpp"

namespace nbody {

void check_theta(double theta) {
    if (!(theta >= 0.0 && theta <= 1.0)) {
        throw std::invalid_argument(std::format("theta must be in [0, 1], got {}", theta));
    }
}

void check_softening(double softening) {
    if (!std::isfinite(softening) || softening < 0.0) {
        throw std::invalid_argument(
            std::format("softening must be finite and not negative, got {}", softening));
    }
}

void check_thread_count(unsigned thread_count) {
    if (thread_count < 1 || thread_count > MAX_THREADS) {
        throw std::invalid_argument(std::format(
            "thread count must be from 1 to {}, got {}", MAX_THREADS, thread_count));
    }
}

std::vector<Vec3> compute_accelerations(const ParticleSet& particles, const ForceConfig& config) {
    check_softening(config.softening);
    check_theta(config.theta);
    check_thread_count(config.thread_count);
    const double softening_squared = config.softening * config.softening;
    if (config.method == ForceMethod::tree) {
        return tree_accelerations(particles, softening_squared, config.theta, config.thread_count);
    }
    return direct_accelerations(particles, softening_squared, config.thread_count);
}

}  // namespace nbody
