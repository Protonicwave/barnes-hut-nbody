#include <algorithm>
#include <cmath>
#include <cstddef>
#include <vector>

#include "force_kernels.hpp"
#include "nbody/inspection.hpp"

namespace nbody {

namespace {

// Same index convention as the accuracy tests: the value at fraction of the
// way through the sorted values, rounded down.
double quantile(const std::vector<double>& sorted, double fraction) {
    if (sorted.empty()) {
        return 0.0;
    }
    return sorted[static_cast<std::size_t>(fraction * static_cast<double>(sorted.size() - 1))];
}

double length(const Vec3& vector) { return std::sqrt(dot(vector, vector)); }

}  // namespace

ForceComparison force_comparison(const ParticleSet& particles, const ForceConfig& config) {
    const auto actual = compute_accelerations(particles, config);
    ForceConfig reference = config;
    reference.method = ForceMethod::direct;
    const auto exact = compute_accelerations(particles, reference);

    std::vector<double> errors;
    errors.reserve(particles.size());
    for (std::size_t i = 0; i < particles.size(); ++i) {
        const double scale = length(exact[i]);
        if (scale > 0.0) {
            errors.push_back(length(actual[i] - exact[i]) / scale);
        }
    }
    std::ranges::sort(errors);

    ForceComparison comparison;
    comparison.median_error = quantile(errors, 0.5);
    comparison.p99_error = quantile(errors, 0.99);
    if (particles.size() > 0) {
        const auto count = static_cast<double>(particles.size());
        comparison.mean_interactions =
            config.method == ForceMethod::tree
                ? static_cast<double>(
                      tree_interaction_count(particles, config.theta, config.thread_count)) / count
                : count - 1.0;
    }
    return comparison;
}

}  // namespace nbody
