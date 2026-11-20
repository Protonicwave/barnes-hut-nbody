#include <stdexcept>

#include <catch2/catch_test_macros.hpp>

#include "nbody/diagnostics.hpp"
#include "test_support.hpp"

using nbody::ParticleSet;
using nbody::test::relative_difference;

TEST_CASE("kinetic energy is the sum of m v^2 / 2") {
    const ParticleSet set({{}, {}}, {{3, 4, 0}, {0, 0, 2}}, {2.0, 1.0});
    REQUIRE(nbody::kinetic_energy(set) == 25.0 + 2.0);
}

TEST_CASE("potential energy of two bodies is -m1 m2 / r") {
    const ParticleSet set({{0, 0, 0}, {2, 0, 0}}, {{}, {}}, {2.0, 3.0});
    REQUIRE(relative_difference(nbody::potential_energy(set, 0.0), -3.0) < 1e-15);
}

TEST_CASE("potential energy applies the softening") {
    const ParticleSet set({{0, 0, 0}, {3, 0, 0}}, {{}, {}}, {1.0, 1.0});
    REQUIRE(relative_difference(nbody::potential_energy(set, 4.0), -1.0 / 5.0) < 1e-15);
}

TEST_CASE("potential energy of fewer than two bodies is zero") {
    REQUIRE(nbody::potential_energy(ParticleSet({}, {}, {}), 0.0) == 0.0);
    REQUIRE(nbody::potential_energy(ParticleSet({{1, 1, 1}}, {{}}, {1.0}), 0.0) == 0.0);
}

TEST_CASE("potential energy rejects a negative softening, naming it") {
    const ParticleSet set({{}}, {{}}, {1.0});
    REQUIRE_THROWS_OF(nbody::potential_energy(set, -1.0), std::invalid_argument, "got -1");
}

TEST_CASE("momentum is the mass-weighted velocity sum") {
    const ParticleSet set({{}, {}}, {{1, 0, 0}, {0, 2, 0}}, {2.0, 3.0});
    const auto momentum = nbody::total_momentum(set);
    REQUIRE(momentum.x == 2.0);
    REQUIRE(momentum.y == 6.0);
    REQUIRE(momentum.z == 0.0);
}

TEST_CASE("centre of mass is the mass-weighted mean position") {
    const ParticleSet set({{0, 0, 0}, {4, 0, 0}}, {{}, {}}, {3.0, 1.0});
    const auto centre = nbody::centre_of_mass(set);
    REQUIRE(centre.x == 1.0);
    REQUIRE(centre.y == 0.0);
}

TEST_CASE("centre of mass of an empty set is the origin") {
    const auto centre = nbody::centre_of_mass(ParticleSet({}, {}, {}));
    REQUIRE(centre.x == 0.0);
    REQUIRE(centre.y == 0.0);
    REQUIRE(centre.z == 0.0);
}
