#include "nbody/setups.hpp"

#include <cmath>
#include <format>
#include <numbers>
#include <random>
#include <stdexcept>
#include <utility>
#include <vector>

namespace nbody {

namespace {

// Uniform deviates are built from raw engine bits because the standard
// distributions differ between standard libraries, which would make seeds
// give different sets on different platforms.
class UniformSource {
public:
    explicit UniformSource(std::uint64_t seed) : engine_(seed) {}

    // Uniform in the open interval (0, 1).
    double next() {
        constexpr double SCALE = 1.0 / 9007199254740992.0;  // 2^-53
        return (static_cast<double>(engine_() >> 11) + 0.5) * SCALE;
    }

    // Unit vector uniform on the sphere.
    Vec3 direction() {
        const double z = 2.0 * next() - 1.0;
        const double phi = 2.0 * std::numbers::pi * next();
        const double rho = std::sqrt(1.0 - z * z);
        return {rho * std::cos(phi), rho * std::sin(phi), z};
    }

private:
    std::mt19937_64 engine_;
};

void check_count(std::size_t count) {
    if (count > MAX_PARTICLES) {
        throw std::invalid_argument(
            std::format("particle count {} exceeds the maximum {}", count, MAX_PARTICLES));
    }
}

// Equal-mass set of total mass 1, shifted so the centre of mass and the total
// momentum are zero.
ParticleSet equal_mass_set(std::vector<Vec3> positions, std::vector<Vec3> velocities) {
    const std::size_t count = positions.size();
    if (count > 0) {
        Vec3 mean_position;
        Vec3 mean_velocity;
        for (std::size_t i = 0; i < count; ++i) {
            mean_position += positions[i];
            mean_velocity += velocities[i];
        }
        mean_position = (1.0 / static_cast<double>(count)) * mean_position;
        mean_velocity = (1.0 / static_cast<double>(count)) * mean_velocity;
        for (std::size_t i = 0; i < count; ++i) {
            positions[i] = positions[i] - mean_position;
            velocities[i] = velocities[i] - mean_velocity;
        }
    }
    const double mass = 1.0 / static_cast<double>(count);
    return {std::move(positions), std::move(velocities), std::vector<double>(count, mass)};
}

// Speed ratio q = v / v_escape from the density g(q) = q^2 (1 - q^2)^(7/2) by
// von Neumann rejection (Aarseth, Henon and Wielen 1974).
double plummer_speed_ratio(UniformSource& source) {
    constexpr double ENVELOPE = 0.1;
    for (;;) {
        const double q = source.next();
        const double g = q * q * std::pow(1.0 - q * q, 3.5);
        if (ENVELOPE * source.next() < g) {
            return q;
        }
    }
}

}  // namespace

ParticleSet plummer_sphere(std::size_t count, std::uint64_t seed) {
    check_count(count);
    const double scale_radius = 3.0 * std::numbers::pi / 16.0;
    UniformSource source(seed);
    std::vector<Vec3> positions(count);
    std::vector<Vec3> velocities(count);
    for (std::size_t i = 0; i < count; ++i) {
        const double radius =
            scale_radius / std::sqrt(std::pow(source.next(), -2.0 / 3.0) - 1.0);
        const double escape_speed = std::sqrt(2.0 / std::sqrt(radius * radius + scale_radius * scale_radius));
        positions[i] = radius * source.direction();
        velocities[i] = (plummer_speed_ratio(source) * escape_speed) * source.direction();
    }
    return equal_mass_set(std::move(positions), std::move(velocities));
}

ParticleSet uniform_sphere(std::size_t count, std::uint64_t seed) {
    check_count(count);
    UniformSource source(seed);
    std::vector<Vec3> positions(count);
    for (std::size_t i = 0; i < count; ++i) {
        positions[i] = std::cbrt(source.next()) * source.direction();
    }
    return equal_mass_set(std::move(positions), std::vector<Vec3>(count));
}

ParticleSet kepler_binary(double eccentricity, double semi_major_axis) {
    if (!(eccentricity >= 0.0 && eccentricity < 1.0)) {
        throw std::invalid_argument(
            std::format("eccentricity must be in [0, 1), got {}", eccentricity));
    }
    if (!std::isfinite(semi_major_axis) || semi_major_axis <= 0.0) {
        throw std::invalid_argument(
            std::format("semi-major axis must be finite and positive, got {}", semi_major_axis));
    }
    constexpr double TOTAL_MASS = 1.0;
    const double separation = semi_major_axis * (1.0 + eccentricity);
    const double relative_speed =
        std::sqrt(TOTAL_MASS * (2.0 / separation - 1.0 / semi_major_axis));
    // Equal masses: each body carries half the relative offset and velocity.
    return {{{-0.5 * separation, 0.0, 0.0}, {0.5 * separation, 0.0, 0.0}},
            {{0.0, -0.5 * relative_speed, 0.0}, {0.0, 0.5 * relative_speed, 0.0}},
            {0.5, 0.5}};
}

}  // namespace nbody
