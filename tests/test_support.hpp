#pragma once

#include <cmath>
#include <utility>
#include <vector>

#include <catch2/matchers/catch_matchers_exception.hpp>
#include <catch2/matchers/catch_matchers_string.hpp>

#include "nbody/diagnostics.hpp"
#include "nbody/particles.hpp"

#define REQUIRE_THROWS_OF(expression, exception_type, text)     \
    REQUIRE_THROWS_MATCHES(                                     \
        expression, exception_type,                             \
        Catch::Matchers::MessageMatches(Catch::Matchers::ContainsSubstring(text)))

namespace nbody::test {

inline double total_energy(const ParticleSet& particles, double softening) {
    return kinetic_energy(particles) + potential_energy(particles, softening);
}

inline double relative_difference(double value, double reference) {
    return std::abs(value - reference) / std::abs(reference);
}

inline double distance(const Vec3& a, const Vec3& b) {
    const Vec3 offset = a - b;
    return std::sqrt(dot(offset, offset));
}

inline ParticleSet copy_with_negated_velocities(const ParticleSet& particles) {
    std::vector<Vec3> velocities(particles.velocities().begin(), particles.velocities().end());
    for (Vec3& velocity : velocities) {
        velocity = -1.0 * velocity;
    }
    return {std::vector<Vec3>(particles.positions().begin(), particles.positions().end()),
            std::move(velocities),
            std::vector<double>(particles.masses().begin(), particles.masses().end())};
}

}  // namespace nbody::test
