#include <algorithm>
#include <cmath>
#include <cstddef>
#include <set>
#include <stdexcept>
#include <vector>

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include "nbody/forces.hpp"
#include "nbody/inspection.hpp"
#include "nbody/setups.hpp"
#include "test_support.hpp"

using nbody::compute_accelerations;
using nbody::ForceConfig;
using nbody::ForceMethod;
using nbody::ParticleSet;
using nbody::TreeCell;
using nbody::Vec3;
using nbody::WalkTrace;
using nbody::test::distance;

namespace {

double softening_for(std::size_t count) { return 4.0 / std::sqrt(static_cast<double>(count)); }

ForceConfig tree_config(double softening, double theta) {
    return {.softening = softening, .method = ForceMethod::tree, .theta = theta};
}

// The acceleration on a particle from the sources a trace lists.
Vec3 force_from_trace(const ParticleSet& particles, const WalkTrace& trace, std::size_t index,
                      double softening) {
    const auto pull = [&](const Vec3& source, double mass) {
        const Vec3 offset = source - particles.positions()[index];
        const double softened = dot(offset, offset) + softening * softening;
        return (mass / (softened * std::sqrt(softened))) * offset;
    };
    Vec3 sum;
    for (const TreeCell& cell : trace.accepted) {
        sum += pull(cell.centre_of_mass, cell.mass);
    }
    for (const std::size_t k : trace.particles) {
        sum += pull(particles.positions()[k], particles.masses()[k]);
    }
    return sum;
}

double traced_mass(const ParticleSet& particles, const WalkTrace& trace) {
    double mass = 0.0;
    for (const TreeCell& cell : trace.accepted) {
        mass += cell.mass;
    }
    for (const std::size_t k : trace.particles) {
        mass += particles.masses()[k];
    }
    return mass;
}

bool is_inside(const TreeCell& child, const TreeCell& parent) {
    const double slack = 1e-12 * parent.size;
    const double reach = 0.5 * (parent.size - child.size) + slack;
    return std::abs(child.centre.x - parent.centre.x) <= reach &&
           std::abs(child.centre.y - parent.centre.y) <= reach &&
           std::abs(child.centre.z - parent.centre.z) <= reach;
}

}  // namespace

TEST_CASE("a trace sums to the mass of every other particle and to the tree force") {
    const auto particles = nbody::plummer_sphere(1024, 1);
    const double softening = softening_for(1024);
    const auto forces = compute_accelerations(particles, tree_config(softening, 0.5));
    for (const std::size_t index : {0UL, 17UL, 500UL, 1023UL}) {
        const WalkTrace trace =
            nbody::tree_walk_trace(particles, tree_config(softening, 0.5), index);
        CHECK(traced_mass(particles, trace) ==
              Catch::Approx(1.0 - particles.masses()[index]).epsilon(1e-12));
        CHECK(distance(force_from_trace(particles, trace, index, softening), forces[index]) <=
              1e-12 * distance(forces[index], Vec3{}));
        CHECK(std::ranges::find(trace.particles, index) == trace.particles.end());
        CHECK(!trace.accepted.empty());
        CHECK(!trace.opened.empty());
    }
}

TEST_CASE("a trace at theta 0 sums every other particle and accepts no cell") {
    const auto particles = nbody::plummer_sphere(256, 1);
    const WalkTrace trace = nbody::tree_walk_trace(particles, tree_config(0.1, 0.0), 5);
    CHECK(trace.accepted.empty());
    CHECK(trace.particles.size() == 255);
    CHECK(trace.interaction_count() == 255);
}

TEST_CASE("a trace rejects an index past the end and a theta outside 0 to 1") {
    const auto particles = nbody::plummer_sphere(16, 1);
    REQUIRE_THROWS_OF(nbody::tree_walk_trace(particles, tree_config(0.1, 0.5), 16),
                      std::invalid_argument, "below 16, got 16");
    REQUIRE_THROWS_OF(nbody::tree_walk_trace(particles, tree_config(0.1, 1.5), 0),
                      std::invalid_argument, "got 1.5");
}

TEST_CASE("tree cells span depths 2 to 5, each inside a cell one level up") {
    const auto particles = nbody::plummer_sphere(1024, 1);
    const auto cells = nbody::tree_cells(particles, 5);
    std::set<unsigned> depths;
    for (const TreeCell& cell : cells) {
        depths.insert(cell.depth);
        CHECK(cell.depth >= 2);
        CHECK(cell.depth <= 5);
        CHECK(cell.mass > 0.0);
        if (cell.depth > 2) {
            CHECK(std::ranges::any_of(cells, [&](const TreeCell& parent) {
                return parent.depth + 1 == cell.depth && is_inside(cell, parent);
            }));
        }
    }
    CHECK(depths.contains(2));
    CHECK(depths.contains(3));
    CHECK(cells.size() > nbody::tree_cells(particles, 3).size());
}

TEST_CASE("tree cells reject a depth outside 2 to the maximum and are empty for no particles") {
    const auto particles = nbody::plummer_sphere(16, 1);
    REQUIRE_THROWS_OF(nbody::tree_cells(particles, 1), std::invalid_argument, "got 1");
    REQUIRE_THROWS_OF(nbody::tree_cells(particles, nbody::MAX_TREE_DEPTH + 1),
                      std::invalid_argument, "got 22");
    CHECK(nbody::tree_cells(nbody::plummer_sphere(0, 1), 5).empty());
}

TEST_CASE("comparison at theta 0 finds no error and N - 1 interactions") {
    const auto particles = nbody::plummer_sphere(512, 1);
    const auto comparison =
        nbody::force_comparison(particles, tree_config(softening_for(512), 0.0));
    CHECK(comparison.median_error < 1e-12);
    CHECK(comparison.p99_error < 1e-12);
    CHECK(comparison.mean_interactions == 511.0);
}

TEST_CASE("comparison at theta 0.5 gives the tree error with far fewer interactions") {
    const auto particles = nbody::plummer_sphere(4096, 1);
    const double softening = softening_for(4096);
    const auto comparison = nbody::force_comparison(particles, tree_config(softening, 0.5));

    const auto tree = compute_accelerations(particles, tree_config(softening, 0.5));
    const auto direct = compute_accelerations(particles, ForceConfig{.softening = softening});
    std::vector<double> errors(particles.size());
    for (std::size_t i = 0; i < errors.size(); ++i) {
        errors[i] = distance(tree[i], direct[i]) / distance(direct[i], Vec3{});
    }
    std::ranges::sort(errors);
    CHECK(comparison.median_error == errors[(errors.size() - 1) / 2]);
    CHECK(comparison.p99_error == errors[static_cast<std::size_t>(0.99 * 4095.0)]);
    CHECK(comparison.median_error < 2e-3);
    CHECK(comparison.p99_error > comparison.median_error);
    CHECK(comparison.mean_interactions < 0.4 * 4096.0);
}

TEST_CASE("comparison counts the interactions each trace lists") {
    const auto particles = nbody::plummer_sphere(128, 1);
    const ForceConfig config = tree_config(softening_for(128), 0.7);
    double total = 0.0;
    for (std::size_t i = 0; i < particles.size(); ++i) {
        total +=
            static_cast<double>(nbody::tree_walk_trace(particles, config, i).interaction_count());
    }
    CHECK(nbody::force_comparison(particles, config).mean_interactions == total / 128.0);
}

TEST_CASE("comparison of direct summation with itself has no error") {
    const auto particles = nbody::plummer_sphere(64, 1);
    const auto comparison = nbody::force_comparison(particles, ForceConfig{.softening = 0.1});
    CHECK(comparison.median_error == 0.0);
    CHECK(comparison.p99_error == 0.0);
    CHECK(comparison.mean_interactions == 63.0);
}

TEST_CASE("comparison of no particles and of one particle is all zero") {
    for (const std::size_t count : {0UL, 1UL}) {
        const auto comparison =
            nbody::force_comparison(nbody::plummer_sphere(count, 1), tree_config(0.1, 0.5));
        CHECK(comparison.median_error == 0.0);
        CHECK(comparison.p99_error == 0.0);
        CHECK(comparison.mean_interactions == 0.0);
    }
}

TEST_CASE("comparison rejects an invalid configuration") {
    REQUIRE_THROWS_OF(nbody::force_comparison(nbody::plummer_sphere(8, 1), tree_config(0.1, 2.0)),
                      std::invalid_argument, "got 2");
}
