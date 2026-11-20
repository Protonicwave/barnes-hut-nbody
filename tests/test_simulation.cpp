#include <algorithm>
#include <cmath>
#include <limits>
#include <numbers>
#include <stdexcept>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include "nbody/diagnostics.hpp"
#include "nbody/setups.hpp"
#include "nbody/simulation.hpp"
#include "test_support.hpp"

using nbody::ForceConfig;
using nbody::ParticleSet;
using nbody::Simulation;
using nbody::Vec3;
using nbody::test::relative_difference;
using nbody::test::total_energy;

namespace {

constexpr double ORBITAL_PERIOD = 2.0 * std::numbers::pi;  // a = 1, total mass 1.

// Largest relative energy error seen after each step, split by orbit: element
// k holds the maximum over orbit k + 1.
std::vector<double> kepler_error_per_orbit(double timestep, int steps_per_orbit, int orbits) {
    Simulation simulation(nbody::kepler_binary(0.5, 1.0), ForceConfig{}, timestep);
    const double initial_energy = total_energy(simulation.particles(), 0.0);
    std::vector<double> per_orbit(static_cast<std::size_t>(orbits), 0.0);
    for (int orbit = 0; orbit < orbits; ++orbit) {
        for (int s = 0; s < steps_per_orbit; ++s) {
            simulation.step(1);
            const double error =
                relative_difference(total_energy(simulation.particles(), 0.0), initial_energy);
            per_orbit[static_cast<std::size_t>(orbit)] =
                std::max(per_orbit[static_cast<std::size_t>(orbit)], error);
        }
    }
    return per_orbit;
}

double largest(const std::vector<double>& values, std::size_t first, std::size_t last) {
    return *std::max_element(values.begin() + static_cast<std::ptrdiff_t>(first),
                             values.begin() + static_cast<std::ptrdiff_t>(last));
}

}  // namespace

TEST_CASE("kepler orbit keeps the energy error under 1e-3 for ten orbits") {
    const auto errors = kepler_error_per_orbit(ORBITAL_PERIOD / 1000.0, 1000, 10);
    REQUIRE(largest(errors, 0, 10) < 1e-3);
}

TEST_CASE("kepler energy error does not grow over a hundred orbits") {
    const auto errors = kepler_error_per_orbit(ORBITAL_PERIOD / 1000.0, 1000, 100);
    REQUIRE(largest(errors, 90, 100) <= 1.2 * largest(errors, 0, 10));
}

TEST_CASE("halving the timestep divides the kepler energy error by about four") {
    const double coarse = largest(kepler_error_per_orbit(ORBITAL_PERIOD / 500.0, 500, 10), 0, 10);
    const double fine = largest(kepler_error_per_orbit(ORBITAL_PERIOD / 1000.0, 1000, 10), 0, 10);
    REQUIRE(coarse / fine >= 3.5);
    REQUIRE(coarse / fine <= 4.5);
}

TEST_CASE("running forward then back from negated velocities returns the start") {
    const double timestep = ORBITAL_PERIOD / 1000.0;
    Simulation forward(nbody::kepler_binary(0.5, 1.0), ForceConfig{}, timestep);
    const Vec3 start = forward.particles().positions()[0];
    forward.step(300);
    REQUIRE(nbody::test::distance(forward.particles().positions()[0], start) > 0.1);
    Simulation backward(nbody::test::copy_with_negated_velocities(forward.particles()),
                        ForceConfig{}, timestep);
    backward.step(300);
    REQUIRE(nbody::test::distance(backward.particles().positions()[0], start) < 1e-10);
}

TEST_CASE("plummer sphere conserves momentum and energy under direct leapfrog") {
    constexpr std::size_t COUNT = 256;
    const double softening = 4.0 / std::sqrt(static_cast<double>(COUNT));
    Simulation simulation(nbody::plummer_sphere(COUNT, 1), ForceConfig{softening}, 1.0 / 128.0);
    const double initial_energy = total_energy(simulation.particles(), softening);
    simulation.step(725);
    REQUIRE(relative_difference(total_energy(simulation.particles(), softening), initial_energy) <
            1.4e-5);
    simulation.step(275);
    REQUIRE(std::sqrt(dot(nbody::total_momentum(simulation.particles()),
                          nbody::total_momentum(simulation.particles()))) < 1e-12);
}

TEST_CASE("time is the number of steps times the timestep") {
    Simulation simulation(nbody::kepler_binary(0.5, 1.0), ForceConfig{}, 0.25);
    REQUIRE(simulation.time() == 0.0);
    simulation.step(6);
    REQUIRE(simulation.time() == 1.5);
}

TEST_CASE("an empty simulation steps without changing anything") {
    Simulation simulation(ParticleSet({}, {}, {}), ForceConfig{}, 0.1);
    simulation.step(5);
    REQUIRE(simulation.particles().size() == 0);
    REQUIRE(simulation.time() == 0.0);
}

TEST_CASE("rejects a timestep that is not positive and finite, naming it") {
    const auto make = [](double timestep) {
        return Simulation(nbody::kepler_binary(0.5, 1.0), ForceConfig{}, timestep);
    };
    REQUIRE_THROWS_OF(make(0.0), std::invalid_argument, "got 0");
    REQUIRE_THROWS_OF(make(-0.5), std::invalid_argument, "got -0.5");
    REQUIRE_THROWS_OF(make(std::numeric_limits<double>::quiet_NaN()), std::invalid_argument,
                      "got nan");
    REQUIRE_THROWS_OF(make(std::numeric_limits<double>::infinity()), std::invalid_argument,
                      "got inf");
}

TEST_CASE("rejects an invalid softening, naming it") {
    REQUIRE_THROWS_OF(Simulation(nbody::kepler_binary(0.5, 1.0), ForceConfig{-1.0}, 0.1),
                      std::invalid_argument, "got -1");
}

TEST_CASE("a position overflowing to infinity throws naming particle and step") {
    Simulation simulation(ParticleSet({{0, 0, 0}, {2, 0, 0}}, {{}, {}}, {1e308, 1e308}),
                          ForceConfig{}, 10.0);
    REQUIRE_THROWS_OF(simulation.step(3), std::runtime_error,
                      "position of particle 0 became non-finite at step 1");
}

TEST_CASE("particles meeting with zero softening throw naming particle and step") {
    Simulation simulation(ParticleSet({{0, 0, 0}, {1, 0, 0}}, {{}, {}}, {1.0, 1.0}),
                          ForceConfig{}, 1.0);
    REQUIRE_THROWS_OF(simulation.step(1), std::runtime_error,
                      "velocity of particle 0 became non-finite at step 1");
}

TEST_CASE("simulation reports the force configuration it was built with") {
    const ForceConfig config{.softening = 0.125,
                             .method = nbody::ForceMethod::tree,
                             .theta = 0.7,
                             .thread_count = 3};
    const Simulation simulation(nbody::kepler_binary(0.5, 1.0), config, 0.01);
    CHECK(simulation.config().softening == 0.125);
    CHECK(simulation.config().method == nbody::ForceMethod::tree);
    CHECK(simulation.config().theta == 0.7);
    CHECK(simulation.config().thread_count == 3);
}

TEST_CASE("switching from direct to the exact tree continues the same trajectory") {
    const auto particles = nbody::plummer_sphere(128, 1);
    const ForceConfig direct{.softening = 0.25};
    Simulation reference(particles, direct, 1.0 / 128);
    Simulation switched(particles, direct, 1.0 / 128);
    reference.step(20);
    switched.step(10);
    switched.set_force_config({.softening = 0.25, .method = nbody::ForceMethod::tree, .theta = 0.0});
    switched.step(10);
    CHECK(switched.config().method == nbody::ForceMethod::tree);
    CHECK(switched.time() == reference.time());
    for (std::size_t i = 0; i < particles.size(); ++i) {
        CHECK(nbody::test::distance(switched.particles().positions()[i],
                                    reference.particles().positions()[i]) < 1e-10);
    }
}

TEST_CASE("an invalid force configuration is rejected and the simulation keeps its own") {
    Simulation simulation(nbody::kepler_binary(0.5, 1.0), ForceConfig{.softening = 0.1}, 0.01);
    REQUIRE_THROWS_OF(simulation.set_force_config({.softening = 0.1, .theta = 1.5}),
                      std::invalid_argument, "got 1.5");
    CHECK(simulation.config().theta == 0.5);
    CHECK(simulation.config().softening == 0.1);
}
