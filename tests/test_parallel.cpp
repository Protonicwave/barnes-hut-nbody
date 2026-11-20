#include <cstddef>
#include <stdexcept>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include "nbody/diagnostics.hpp"
#include "nbody/forces.hpp"
#include "nbody/setups.hpp"
#include "test_support.hpp"

using nbody::compute_accelerations;
using nbody::ForceConfig;
using nbody::ForceMethod;
using nbody::MAX_THREADS;
using nbody::potential_energy;
using nbody::Vec3;

namespace {

constexpr double SOFTENING = 0.125;

bool identical(const std::vector<Vec3>& a, const std::vector<Vec3>& b) {
    if (a.size() != b.size()) {
        return false;
    }
    for (std::size_t i = 0; i < a.size(); ++i) {
        if (a[i].x != b[i].x || a[i].y != b[i].y || a[i].z != b[i].z) {
            return false;
        }
    }
    return true;
}

ForceConfig with_threads(ForceMethod method, unsigned thread_count) {
    return ForceConfig{SOFTENING, method, 0.5, thread_count};
}

}  // namespace

TEST_CASE("direct accelerations are bitwise identical for any thread count") {
    const auto particles = nbody::plummer_sphere(2048, 1);
    const auto serial = compute_accelerations(particles, with_threads(ForceMethod::direct, 1));
    REQUIRE(identical(serial,
                      compute_accelerations(particles, with_threads(ForceMethod::direct, 4))));
}

TEST_CASE("tree accelerations are bitwise identical for any thread count") {
    const auto particles = nbody::plummer_sphere(2048, 1);
    const auto serial = compute_accelerations(particles, with_threads(ForceMethod::tree, 1));
    REQUIRE(identical(serial,
                      compute_accelerations(particles, with_threads(ForceMethod::tree, 4))));
}

TEST_CASE("potential energy is bitwise identical for any thread count") {
    const auto particles = nbody::plummer_sphere(2048, 1);
    REQUIRE(potential_energy(particles, SOFTENING, 1) ==
            potential_energy(particles, SOFTENING, 4));
}

TEST_CASE("a thread count outside 1 to MAX_THREADS is rejected") {
    const auto particles = nbody::plummer_sphere(16, 1);
    REQUIRE_THROWS_OF(compute_accelerations(particles, with_threads(ForceMethod::direct, 0)),
                      std::invalid_argument, "got 0");
    REQUIRE_THROWS_OF(
        compute_accelerations(particles, with_threads(ForceMethod::tree, MAX_THREADS + 1)),
        std::invalid_argument, "got 257");
    REQUIRE_THROWS_OF(potential_energy(particles, SOFTENING, 0), std::invalid_argument, "got 0");
    REQUIRE_THROWS_OF(potential_energy(particles, SOFTENING, MAX_THREADS + 1),
                      std::invalid_argument, "got 257");
}
