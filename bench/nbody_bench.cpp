// Times one force evaluation, tree build included, on a Plummer sphere.
// Benchmark names are Force/<method>/<particle count>/<threads>/real_time, the
// form bench/check_budgets.py reads. Give --benchmark_repetitions on the command
// line: the budget check reads the median of the repetitions.

#include <benchmark/benchmark.h>

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <vector>

#include "nbody/forces.hpp"
#include "nbody/setups.hpp"

namespace {

constexpr std::uint64_t SEED = 1;
constexpr double THETA = 0.5;
constexpr int ALL_THREADS = 8;

void force_evaluation(benchmark::State& state, nbody::ForceMethod method) {
    const auto count = static_cast<std::size_t>(state.range(0));
    const auto thread_count = static_cast<unsigned>(state.range(1));
    const auto particles = nbody::plummer_sphere(count, SEED);
    const nbody::ForceConfig config{4.0 / std::sqrt(static_cast<double>(count)), method, THETA,
                                    thread_count};
    for (auto _ : state) {  // NOLINT(clang-analyzer-deadcode.DeadStores): the benchmark loop idiom
        benchmark::DoNotOptimize(nbody::compute_accelerations(particles, config));
    }
}

struct Case {
    std::int64_t count;
    std::int64_t threads;
};

void register_cases(const char* name, nbody::ForceMethod method, const std::vector<Case>& cases) {
    auto* registration = benchmark::RegisterBenchmark(name, force_evaluation, method);
    for (const Case& entry : cases) {
        registration->Args({entry.count, entry.threads});
    }
    registration->UseRealTime()->Unit(benchmark::kMillisecond);
}

// Counts 2^first_exponent to 2^last_exponent, each on ALL_THREADS threads.
std::vector<Case> powers_of_two(int first_exponent, int last_exponent) {
    std::vector<Case> cases;
    for (int exponent = first_exponent; exponent <= last_exponent; ++exponent) {
        cases.push_back({std::int64_t{1} << exponent, ALL_THREADS});
    }
    return cases;
}

}  // namespace

int main(int argc, char** argv) {
    register_cases("Force/direct", nbody::ForceMethod::direct, powers_of_two(10, 16));
    // The tree on fewer threads at one count shows the scaling.
    std::vector<Case> tree_cases = powers_of_two(10, 17);
    for (const std::int64_t threads : {1, 2, 4}) {
        tree_cases.push_back({std::int64_t{1} << 16, threads});
    }
    register_cases("Force/tree", nbody::ForceMethod::tree, tree_cases);
    benchmark::Initialize(&argc, argv);
    if (benchmark::ReportUnrecognizedArguments(argc, argv)) {
        return 1;
    }
    benchmark::RunSpecifiedBenchmarks();
    benchmark::Shutdown();
    return 0;
}
