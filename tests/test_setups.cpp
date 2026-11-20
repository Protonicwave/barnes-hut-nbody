#include <algorithm>
#include <cmath>
#include <limits>
#include <numbers>
#include <stdexcept>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include "nbody/diagnostics.hpp"
#include "nbody/setups.hpp"
#include "test_support.hpp"

using nbody::ParticleSet;
using nbody::Vec3;
using nbody::test::relative_difference;

namespace {

double total_mass(const ParticleSet& set) {
    double sum = 0.0;
    for (const double mass : set.masses()) {
        sum += mass;
    }
    return sum;
}

double norm(const Vec3& v) { return std::sqrt(dot(v, v)); }

double median_radius(const ParticleSet& set) {
    std::vector<double> radii;
    for (const Vec3& position : set.positions()) {
        radii.push_back(norm(position));
    }
    std::sort(radii.begin(), radii.end());
    return 0.5 * (radii[radii.size() / 2 - 1] + radii[radii.size() / 2]);
}

}  // namespace

TEST_CASE("plummer sphere has unit mass and zero centre of mass and momentum") {
    const ParticleSet set = nbody::plummer_sphere(4096, 1);
    REQUIRE(set.size() == 4096);
    REQUIRE(std::abs(total_mass(set) - 1.0) < 1e-12);
    REQUIRE(norm(nbody::centre_of_mass(set)) < 1e-12);
    REQUIRE(norm(nbody::total_momentum(set)) < 1e-12);
}

TEST_CASE("plummer sphere has the half-mass radius of a Plummer model") {
    const double scale_radius = 3.0 * std::numbers::pi / 16.0;
    const double expected_half_mass_radius = 1.3048 * scale_radius;
    const double measured = median_radius(nbody::plummer_sphere(4096, 1));
    REQUIRE(relative_difference(measured, expected_half_mass_radius) < 0.05);
}

TEST_CASE("plummer sphere is in virial equilibrium at energy -1/4") {
    const ParticleSet set = nbody::plummer_sphere(4096, 1);
    const double kinetic = nbody::kinetic_energy(set);
    const double potential = nbody::potential_energy(set, 0.0);
    REQUIRE(std::abs(2.0 * kinetic / potential + 1.0) <= 0.05);
    REQUIRE(relative_difference(kinetic + potential, -0.25) <= 0.05);
}

TEST_CASE("plummer sphere repeats for one seed and differs for another") {
    const ParticleSet first = nbody::plummer_sphere(64, 7);
    const ParticleSet again = nbody::plummer_sphere(64, 7);
    const ParticleSet other = nbody::plummer_sphere(64, 8);
    for (std::size_t i = 0; i < 64; ++i) {
        REQUIRE(first.positions()[i].x == again.positions()[i].x);
        REQUIRE(first.velocities()[i].z == again.velocities()[i].z);
    }
    REQUIRE(first.positions()[0].x != other.positions()[0].x);
}

TEST_CASE("generators accept zero particles and reject a count above the maximum") {
    REQUIRE(nbody::plummer_sphere(0, 1).size() == 0);
    REQUIRE(nbody::uniform_sphere(0, 1).size() == 0);
    REQUIRE_THROWS_OF(nbody::plummer_sphere(nbody::MAX_PARTICLES + 1, 1), std::invalid_argument,
                      "4194305 exceeds the maximum");
    REQUIRE_THROWS_OF(nbody::uniform_sphere(nbody::MAX_PARTICLES + 1, 1), std::invalid_argument,
                      "4194305 exceeds the maximum");
}

TEST_CASE("uniform sphere is cold, centred and inside a sphere of radius about 1") {
    const ParticleSet set = nbody::uniform_sphere(2048, 3);
    REQUIRE(std::abs(total_mass(set) - 1.0) < 1e-12);
    REQUIRE(norm(nbody::centre_of_mass(set)) < 1e-12);
    REQUIRE(nbody::kinetic_energy(set) == 0.0);
    double largest = 0.0;
    for (const Vec3& position : set.positions()) {
        largest = std::max(largest, norm(position));
    }
    REQUIRE(largest < 1.2);
    REQUIRE(largest > 0.9);
}

TEST_CASE("kepler binary starts at apoapsis with the energy of its orbit") {
    const ParticleSet set = nbody::kepler_binary(0.5, 2.0);
    REQUIRE(set.size() == 2);
    REQUIRE(relative_difference(nbody::test::distance(set.positions()[0], set.positions()[1]),
                                3.0) < 1e-15);
    REQUIRE(norm(nbody::centre_of_mass(set)) < 1e-15);
    REQUIRE(norm(nbody::total_momentum(set)) < 1e-15);
    // E = -G m1 m2 / (2 a) for equal masses of 1/2.
    REQUIRE(relative_difference(nbody::test::total_energy(set, 0.0), -0.25 / 4.0) < 1e-14);
}

TEST_CASE("kepler binary rejects an eccentricity outside [0, 1), naming it") {
    REQUIRE_THROWS_OF(nbody::kepler_binary(1.0, 1.0), std::invalid_argument, "got 1");
    REQUIRE_THROWS_OF(nbody::kepler_binary(-0.1, 1.0), std::invalid_argument, "got -0.1");
    REQUIRE_THROWS_OF(nbody::kepler_binary(std::numeric_limits<double>::quiet_NaN(), 1.0),
                      std::invalid_argument, "got nan");
}

TEST_CASE("kepler binary rejects a semi-major axis that is not positive and finite") {
    REQUIRE_THROWS_OF(nbody::kepler_binary(0.5, 0.0), std::invalid_argument, "got 0");
    REQUIRE_THROWS_OF(nbody::kepler_binary(0.5, std::numeric_limits<double>::infinity()),
                      std::invalid_argument, "got inf");
}
