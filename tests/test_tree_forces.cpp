#include <algorithm>
#include <cmath>
#include <cstddef>
#include <limits>
#include <stdexcept>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include "nbody/forces.hpp"
#include "nbody/setups.hpp"
#include "nbody/simulation.hpp"
#include "test_support.hpp"

using nbody::compute_accelerations;
using nbody::ForceConfig;
using nbody::ForceMethod;
using nbody::ParticleSet;
using nbody::Simulation;
using nbody::Vec3;
using nbody::test::distance;
using nbody::test::relative_difference;
using nbody::test::total_energy;

namespace {

ForceConfig tree_config(double softening, double theta) {
    return ForceConfig{softening, ForceMethod::tree, theta};
}

// |tree - direct| / |direct| for each particle.
std::vector<double> relative_errors(const ParticleSet& particles, double softening, double theta) {
    const auto tree = compute_accelerations(particles, tree_config(softening, theta));
    const auto direct = compute_accelerations(particles, ForceConfig{softening});
    std::vector<double> errors(particles.size());
    for (std::size_t i = 0; i < errors.size(); ++i) {
        errors[i] = distance(tree[i], direct[i]) / distance(direct[i], Vec3{});
    }
    return errors;
}

double quantile(std::vector<double> values, double fraction) {
    std::ranges::sort(values);
    return values[static_cast<std::size_t>(fraction * static_cast<double>(values.size() - 1))];
}

double plummer_softening(std::size_t count) { return 4.0 / std::sqrt(static_cast<double>(count)); }

void require_matches_direct(const ParticleSet& particles, double softening, double tolerance) {
    const auto errors = relative_errors(particles, softening, 0.0);
    REQUIRE(*std::ranges::max_element(errors) < tolerance);
}

}  // namespace

TEST_CASE("tree at theta 0 matches direct summation on a Plummer sphere") {
    require_matches_direct(nbody::plummer_sphere(1024, 1), plummer_softening(1024), 1e-12);
}

TEST_CASE("tree at theta 0 matches direct summation on a Kepler binary") {
    require_matches_direct(nbody::kepler_binary(0.5, 1.0), 0.0, 1e-12);
}

TEST_CASE("tree matches direct summation for no, one and two particles") {
    REQUIRE(compute_accelerations(ParticleSet({}, {}, {}), tree_config(0.1, 0.5)).empty());

    const ParticleSet one({{1, 2, 3}}, {{}}, {5.0});
    const auto alone = compute_accelerations(one, tree_config(0.1, 0.5));
    REQUIRE(alone.size() == 1);
    REQUIRE(alone[0].x == 0.0);
    REQUIRE(alone[0].y == 0.0);
    REQUIRE(alone[0].z == 0.0);

    const ParticleSet two({{0, 0, 0}, {2, 0, 0}}, {{}, {}}, {2.0, 3.0});
    require_matches_direct(two, 0.0, 1e-14);
}

TEST_CASE("tree force error against direct summation stays within the measured bounds") {
    const auto particles = nbody::plummer_sphere(4096, 1);
    const double softening = plummer_softening(4096);
    const double thetas[] = {0.3, 0.5, 0.7, 1.0};
    const double median_bounds[] = {1e-3, 2e-3, 3e-3, 1e-2};
    double previous_median = 0.0;
    for (std::size_t t = 0; t < 4; ++t) {
        const auto errors = relative_errors(particles, softening, thetas[t]);
        const double median = quantile(errors, 0.5);
        INFO("theta " << thetas[t] << " median " << median);
        REQUIRE(median < median_bounds[t]);
        REQUIRE(median > previous_median);
        previous_median = median;
        if (thetas[t] == 0.5) {
            REQUIRE(quantile(errors, 0.99) < 1e-2);
        }
    }
}

TEST_CASE("leapfrog with tree forces conserves energy over two crossing times") {
    constexpr std::size_t COUNT = 1024;
    const double softening = plummer_softening(COUNT);
    Simulation simulation(nbody::plummer_sphere(COUNT, 1), tree_config(softening, 0.5), 1.0 / 128.0);
    const double initial_energy = total_energy(simulation.particles(), softening);
    simulation.step(362);
    const double drift =
        relative_difference(total_energy(simulation.particles(), softening), initial_energy);
    INFO("drift " << drift);
    REQUIRE(drift < 1e-3);
}

TEST_CASE("coincident particles feel no force and stay finite") {
    const ParticleSet set(std::vector<Vec3>(64, Vec3{1, 2, 3}), std::vector<Vec3>(64),
                          std::vector<double>(64, 1.0));
    for (const Vec3& a : compute_accelerations(set, tree_config(0.01, 0.5))) {
        REQUIRE(a.x == 0.0);
        REQUIRE(a.y == 0.0);
        REQUIRE(a.z == 0.0);
    }
}

TEST_CASE("particles sharing the deepest cell are summed individually") {
    // A lattice fixes the box at the unit cube. The cluster sits in the middle
    // of one cell of width 2^-21, so every member shares a leaf at maximum depth.
    std::vector<Vec3> positions;
    for (int i = 0; i < 64; ++i) {
        positions.push_back({(i % 4) / 3.0, ((i / 4) % 4) / 3.0, (i / 16) / 3.0});
    }
    const double cell_middle = 0.25 + std::ldexp(1.0, -22);
    for (int i = 0; i < 64; ++i) {
        positions.push_back({cell_middle + i * 1e-9, cell_middle, cell_middle});
    }
    const ParticleSet set(positions, std::vector<Vec3>(128), std::vector<double>(128, 1.0));
    require_matches_direct(set, 0.01, 1e-12);
}

TEST_CASE("an overflowing extent gives non-finite values as direct summation does") {
    constexpr double HUGE_COORDINATE = 1e308;
    const ParticleSet set({{-HUGE_COORDINATE, 0, 0}, {HUGE_COORDINATE, 0, 0}}, {{}, {}},
                          {1.0, 1.0});
    const auto tree = compute_accelerations(set, tree_config(0.0, 0.5));
    REQUIRE_FALSE(std::isfinite(tree[0].x));
    REQUIRE_FALSE(std::isfinite(compute_accelerations(set, ForceConfig{})[0].x));
}

TEST_CASE("rejects an opening angle outside zero to one, naming it") {
    const ParticleSet set({{}}, {{}}, {1.0});
    REQUIRE_THROWS_OF(compute_accelerations(set, tree_config(0.0, 1.5)), std::invalid_argument,
                      "got 1.5");
    REQUIRE_THROWS_OF(compute_accelerations(set, tree_config(0.0, -0.1)), std::invalid_argument,
                      "got -0.1");
    REQUIRE_THROWS_OF(
        compute_accelerations(set, tree_config(0.0, std::numeric_limits<double>::quiet_NaN())),
        std::invalid_argument, "got nan");
}
