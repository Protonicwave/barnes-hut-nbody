#include "nbody/diagnostics.hpp"

#include <cmath>
#include <vector>

#include "nbody/forces.hpp"

namespace nbody {

double kinetic_energy(const ParticleSet& particles) {
    const auto velocities = particles.velocities();
    const auto masses = particles.masses();
    double sum = 0.0;
    for (std::size_t i = 0; i < particles.size(); ++i) {
        sum += 0.5 * masses[i] * dot(velocities[i], velocities[i]);
    }
    return sum;
}

double potential_energy(const ParticleSet& particles, double softening) {
    check_softening(softening);
    const auto positions = particles.positions();
    const auto masses = particles.masses();
    const double softening_squared = softening * softening;
    std::vector<double> partial_sums(particles.size());
    for (std::size_t i = 0; i < particles.size(); ++i) {
        double sum = 0.0;
        for (std::size_t j = i + 1; j < particles.size(); ++j) {
            const Vec3 offset = positions[j] - positions[i];
            sum -= masses[j] / std::sqrt(dot(offset, offset) + softening_squared);
        }
        partial_sums[i] = masses[i] * sum;
    }
    double total = 0.0;
    for (const double partial : partial_sums) {
        total += partial;
    }
    return total;
}

Vec3 total_momentum(const ParticleSet& particles) {
    const auto velocities = particles.velocities();
    const auto masses = particles.masses();
    Vec3 sum;
    for (std::size_t i = 0; i < particles.size(); ++i) {
        sum += masses[i] * velocities[i];
    }
    return sum;
}

Vec3 centre_of_mass(const ParticleSet& particles) {
    if (particles.size() == 0) {
        return {};
    }
    const auto positions = particles.positions();
    const auto masses = particles.masses();
    Vec3 weighted_sum;
    double total_mass = 0.0;
    for (std::size_t i = 0; i < particles.size(); ++i) {
        weighted_sum += masses[i] * positions[i];
        total_mass += masses[i];
    }
    return (1.0 / total_mass) * weighted_sum;
}

}  // namespace nbody
