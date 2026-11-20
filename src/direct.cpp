#include <cstddef>
#include <vector>

#include "force_kernels.hpp"

namespace nbody {

std::vector<Vec3> direct_accelerations(const ParticleSet& particles, double softening_squared) {
    const auto positions = particles.positions();
    const auto masses = particles.masses();
    std::vector<Vec3> accelerations(particles.size());
    for (std::size_t i = 0; i < particles.size(); ++i) {
        Vec3 sum;
        for (std::size_t j = 0; j < particles.size(); ++j) {
            if (j == i) {
                continue;
            }
            sum += pair_acceleration(positions[j] - positions[i], masses[j], softening_squared);
        }
        accelerations[i] = sum;
    }
    return accelerations;
}

}  // namespace nbody
