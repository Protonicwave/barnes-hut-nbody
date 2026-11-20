// Times one tree force evaluation, tree build included, and prints the median
// as one JSON object. It has no dependencies, so the same source builds
// natively and under Emscripten, where Google Benchmark is not used.
//
//   kernel_timing <particle count> <threads> <repetitions>

#include <algorithm>
#include <charconv>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <string_view>
#include <system_error>
#include <vector>

#include "nbody/forces.hpp"
#include "nbody/setups.hpp"

namespace {

constexpr std::uint64_t SEED = 1;
constexpr double THETA = 0.5;
constexpr std::size_t MAX_REPETITIONS = 1000;

bool parse_unsigned(std::string_view text, std::size_t lowest, std::size_t highest,
                    std::size_t& value) {
    const auto [end, error] = std::from_chars(text.data(), text.data() + text.size(), value);
    return error == std::errc{} && end == text.data() + text.size() && value >= lowest &&
           value <= highest;
}

double median_milliseconds(std::vector<double> times) {
    const auto middle = times.begin() + static_cast<std::ptrdiff_t>(times.size() / 2);
    std::nth_element(times.begin(), middle, times.end());
    return *middle;
}

}  // namespace

int main(int argc, char** argv) {
    std::size_t count = 0;
    std::size_t threads = 0;
    std::size_t repetitions = 0;
    if (argc != 4 || !parse_unsigned(argv[1], 1, nbody::MAX_PARTICLES, count) ||
        !parse_unsigned(argv[2], 1, nbody::MAX_THREADS, threads) ||
        !parse_unsigned(argv[3], 1, MAX_REPETITIONS, repetitions)) {
        std::fputs("usage: kernel_timing <count 1..4194304> <threads 1..256> <repetitions 1..1000>\n",
                   stderr);
        return 2;
    }

    const auto particles = nbody::plummer_sphere(count, SEED);
    const nbody::ForceConfig config{4.0 / std::sqrt(static_cast<double>(count)),
                                    nbody::ForceMethod::tree, THETA,
                                    static_cast<unsigned>(threads)};
    // The first evaluation pays for page faults and cold caches, so it is not timed.
    auto accelerations = nbody::compute_accelerations(particles, config);

    std::vector<double> times;
    times.reserve(repetitions);
    for (std::size_t i = 0; i < repetitions; ++i) {
        const auto start = std::chrono::steady_clock::now();
        accelerations = nbody::compute_accelerations(particles, config);
        const std::chrono::duration<double, std::milli> elapsed =
            std::chrono::steady_clock::now() - start;
        times.push_back(elapsed.count());
    }
    // Reading the result keeps the evaluations from being optimised away.
    const double checksum = accelerations.front().x;
    std::printf("{\"count\": %zu, \"threads\": %zu, \"repetitions\": %zu, \"median_ms\": %.4f, "
                "\"checksum\": %.17g}\n",
                count, threads, repetitions, median_milliseconds(times), checksum);
    return 0;
}
