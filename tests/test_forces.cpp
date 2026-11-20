#include <cmath>
#include <limits>
#include <stdexcept>

#include <catch2/catch_test_macros.hpp>

#include "nbody/forces.hpp"
#include "test_support.hpp"

using nbody::compute_accelerations;
using nbody::ForceConfig;
using nbody::ParticleSet;
using nbody::test::relative_difference;

namespace {

constexpr double TOLERANCE = 1e-14;

}  // namespace

TEST_CASE("two bodies pull each other with m / r^2") {
    const ParticleSet set({{0, 0, 0}, {2, 0, 0}}, {{}, {}}, {2.0, 3.0});
    const auto acceleration = compute_accelerations(set, ForceConfig{});
    REQUIRE(acceleration.size() == 2);
    REQUIRE(relative_difference(acceleration[0].x, 3.0 / 4.0) < TOLERANCE);
    REQUIRE(relative_difference(acceleration[1].x, -2.0 / 4.0) < TOLERANCE);
    REQUIRE(acceleration[0].y == 0.0);
    REQUIRE(acceleration[1].z == 0.0);
}

TEST_CASE("three bodies sum the pulls of the other two") {
    const ParticleSet set({{0, 0, 0}, {1, 0, 0}, {0, 2, 0}}, {{}, {}, {}}, {1.0, 2.0, 3.0});
    const auto acceleration = compute_accelerations(set, ForceConfig{});
    // Body 0: 2 / 1^2 along x, plus 3 / 2^2 along y.
    REQUIRE(relative_difference(acceleration[0].x, 2.0) < TOLERANCE);
    REQUIRE(relative_difference(acceleration[0].y, 0.75) < TOLERANCE);
    // Body 1: 1 / 1^2 along -x, plus the pull of body 2 at distance sqrt(5).
    const double along_diagonal = 3.0 / (5.0 * std::sqrt(5.0));
    REQUIRE(relative_difference(acceleration[1].x, -1.0 - along_diagonal) < TOLERANCE);
    REQUIRE(relative_difference(acceleration[1].y, 2.0 * along_diagonal) < TOLERANCE);
}

TEST_CASE("softening replaces r^2 with r^2 + epsilon^2") {
    const ParticleSet set({{0, 0, 0}, {1, 0, 0}}, {{}, {}}, {1.0, 1.0});
    const auto acceleration = compute_accelerations(set, ForceConfig{1.0});
    REQUIRE(relative_difference(acceleration[0].x, 1.0 / std::pow(2.0, 1.5)) < TOLERANCE);
}

TEST_CASE("one particle feels no force") {
    const ParticleSet set({{1, 2, 3}}, {{}}, {5.0});
    const auto acceleration = compute_accelerations(set, ForceConfig{});
    REQUIRE(acceleration.size() == 1);
    REQUIRE(acceleration[0].x == 0.0);
    REQUIRE(acceleration[0].y == 0.0);
    REQUIRE(acceleration[0].z == 0.0);
}

TEST_CASE("an empty set gives no accelerations") {
    const ParticleSet set({}, {}, {});
    REQUIRE(compute_accelerations(set, ForceConfig{}).empty());
}

TEST_CASE("rejects a softening that is negative or not finite, naming it") {
    const ParticleSet set({{}}, {{}}, {1.0});
    REQUIRE_THROWS_OF(compute_accelerations(set, ForceConfig{-0.5}), std::invalid_argument,
                      "got -0.5");
    REQUIRE_THROWS_OF(
        compute_accelerations(set, ForceConfig{std::numeric_limits<double>::quiet_NaN()}),
        std::invalid_argument, "got nan");
}
