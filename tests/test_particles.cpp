#include <cmath>
#include <limits>
#include <stdexcept>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include "nbody/particles.hpp"
#include "test_support.hpp"

using nbody::MAX_PARTICLES;
using nbody::ParticleSet;
using nbody::Vec3;

namespace {

constexpr double NOT_A_NUMBER = std::numeric_limits<double>::quiet_NaN();
constexpr double INFINITY_VALUE = std::numeric_limits<double>::infinity();

}  // namespace

TEST_CASE("accepts equal-sized finite inputs and exposes them in order") {
    const ParticleSet set({{1, 2, 3}, {4, 5, 6}}, {{0, 0, 1}, {0, 1, 0}}, {2.0, 3.0});
    REQUIRE(set.size() == 2);
    REQUIRE(set.positions()[1].y == 5.0);
    REQUIRE(set.velocities()[0].z == 1.0);
    REQUIRE(set.masses()[1] == 3.0);
}

TEST_CASE("accepts an empty set") {
    const ParticleSet set({}, {}, {});
    REQUIRE(set.size() == 0);
}

TEST_CASE("rejects mismatched sizes naming each size") {
    REQUIRE_THROWS_OF(ParticleSet({{}, {}}, {{}}, {1.0, 1.0}), std::invalid_argument,
                      "got 2, 1 and 2");
    REQUIRE_THROWS_OF(ParticleSet({{}}, {{}}, {1.0, 1.0}), std::invalid_argument,
                      "got 1, 1 and 2");
}

TEST_CASE("rejects a count above the maximum before comparing sizes") {
    std::vector<Vec3> positions(MAX_PARTICLES + 1);
    REQUIRE_THROWS_OF(ParticleSet(std::move(positions), {}, {}), std::invalid_argument,
                      "4194305 exceeds the maximum 4194304");
}

TEST_CASE("rejects a mass that is not positive and finite, naming particle and value") {
    REQUIRE_THROWS_OF(ParticleSet({{}, {}}, {{}, {}}, {1.0, 0.0}), std::invalid_argument,
                      "mass of particle 1 must be positive and finite, got 0");
    REQUIRE_THROWS_OF(ParticleSet({{}}, {{}}, {-2.5}), std::invalid_argument, "got -2.5");
    REQUIRE_THROWS_OF(ParticleSet({{}}, {{}}, {NOT_A_NUMBER}), std::invalid_argument, "got nan");
    REQUIRE_THROWS_OF(ParticleSet({{}}, {{}}, {INFINITY_VALUE}), std::invalid_argument,
                      "got inf");
}

TEST_CASE("rejects a non-finite position, naming particle and value") {
    REQUIRE_THROWS_OF(ParticleSet({{}, {0, NOT_A_NUMBER, 0}}, {{}, {}}, {1.0, 1.0}),
                      std::invalid_argument, "position of particle 1 must be finite");
    REQUIRE_THROWS_OF(ParticleSet({{INFINITY_VALUE, 0, 0}}, {{}}, {1.0}), std::invalid_argument,
                      "(inf, 0, 0)");
}

TEST_CASE("rejects a non-finite velocity, naming particle and value") {
    REQUIRE_THROWS_OF(ParticleSet({{}}, {{0, 0, -INFINITY_VALUE}}, {1.0}), std::invalid_argument,
                      "velocity of particle 0 must be finite, got (0, 0, -inf)");
}
