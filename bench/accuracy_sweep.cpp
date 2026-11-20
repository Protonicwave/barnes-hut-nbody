// Writes the accuracy results as CSV on a Plummer sphere in virial units.
//
//   accuracy_sweep force <output.csv> [count]
//     Relative force error of the tree against direct summation, as quantiles
//     over the particles, for opening angles from 0.2 to 1.0.
//
//   accuracy_sweep drift <output.csv> [count] [end_time]
//     |E(t) - E(0)| / |E(0)| every 1/8 time unit, changing one setting at a
//     time from the reference run: the tree at theta 0.5, timestep 1/128 and
//     softening 4/sqrt(N). Direct summation at the same timestep and softening
//     separates the integration error from the tree error.

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <exception>
#include <format>
#include <fstream>
#include <iostream>
#include <span>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "nbody/diagnostics.hpp"
#include "nbody/forces.hpp"
#include "nbody/setups.hpp"
#include "nbody/simulation.hpp"

namespace {

constexpr std::uint64_t SEED = 1;
constexpr std::size_t DEFAULT_FORCE_COUNT = 16384;
constexpr std::size_t DEFAULT_DRIFT_COUNT = 4096;
// Ten crossing times of a virial Plummer sphere, rounded to whole samples.
constexpr double DEFAULT_END_TIME = 28.25;
constexpr double SAMPLE_INTERVAL = 0.125;
constexpr double REFERENCE_THETA = 0.5;
constexpr double REFERENCE_TIMESTEP = 1.0 / 128.0;
constexpr double REFERENCE_SOFTENING_SCALE = 4.0;
constexpr std::size_t MAX_COUNT = 1 << 20;

unsigned thread_count() {
    const unsigned hardware = std::max(1U, std::thread::hardware_concurrency());
    return std::min(hardware, nbody::MAX_THREADS);
}

double softening_for(std::size_t count, double scale) {
    return scale / std::sqrt(static_cast<double>(count));
}

// Parses with the given function, which reads a prefix of the text and sets the
// length used, and rejects anything that is not the whole text.
template <typename Parse>
auto parse_whole(const std::string& text, const char* what, Parse parse) {
    const auto invalid = [&] {
        return std::invalid_argument(std::format("{} is not valid: '{}'", what, text));
    };
    try {
        std::size_t used = 0;
        const auto value = parse(text, &used);
        if (used != text.size() || std::isspace(static_cast<unsigned char>(text[0]))) {
            throw invalid();
        }
        return value;
    } catch (const std::logic_error&) {  // invalid_argument or out_of_range from the parser
        throw invalid();
    }
}

std::size_t parse_count(const std::string& text) {
    // stoull accepts a leading sign, which would wrap a negative count.
    const bool starts_with_digit = !text.empty() && std::isdigit(static_cast<unsigned char>(text[0]));
    const std::size_t value =
        starts_with_digit ? parse_whole(text, "count", [](const std::string& t, std::size_t* used) {
            return static_cast<std::size_t>(std::stoull(t, used));
        }) : 0;
    if (value < 2 || value > MAX_COUNT) {
        throw std::invalid_argument(
            std::format("count must be a whole number from 2 to {}, got '{}'", MAX_COUNT, text));
    }
    return value;
}

double parse_end_time(const std::string& text) {
    const double value = parse_whole(text, "end time", [](const std::string& t, std::size_t* used) {
        return std::stod(t, used);
    });
    if (!(value >= SAMPLE_INTERVAL) || !std::isfinite(value)) {
        throw std::invalid_argument(
            std::format("end time must be finite and at least {}, got '{}'", SAMPLE_INTERVAL, text));
    }
    return value;
}

double length(const nbody::Vec3& vector) { return std::sqrt(dot(vector, vector)); }

double quantile(const std::vector<double>& sorted, double fraction) {
    return sorted[static_cast<std::size_t>(fraction * static_cast<double>(sorted.size() - 1))];
}

void write_force_error(std::ostream& out, std::size_t count) {
    const auto particles = nbody::plummer_sphere(count, SEED);
    const double softening = softening_for(count, REFERENCE_SOFTENING_SCALE);
    const unsigned threads = thread_count();
    const auto direct = nbody::compute_accelerations(
        particles, {softening, nbody::ForceMethod::direct, REFERENCE_THETA, threads});
    out << "theta,median,p90,p99,max\n";
    for (int tenths = 2; tenths <= 10; ++tenths) {
        const double theta = tenths / 10.0;
        const auto tree = nbody::compute_accelerations(
            particles, {softening, nbody::ForceMethod::tree, theta, threads});
        std::vector<double> errors(count);
        for (std::size_t i = 0; i < count; ++i) {
            errors[i] = length(tree[i] - direct[i]) / length(direct[i]);
        }
        std::ranges::sort(errors);
        out << std::format("{},{:.6e},{:.6e},{:.6e},{:.6e}\n", theta, quantile(errors, 0.5),
                           quantile(errors, 0.9), quantile(errors, 0.99), errors.back());
    }
}

struct DriftRun {
    nbody::ForceMethod method;
    double theta;  // meaningful for the tree only
    double timestep;
    double softening_scale;
};

// The reference run, then each factor varied alone, for the tree and for
// direct summation, without repeats.
std::vector<DriftRun> drift_runs() {
    std::vector<DriftRun> runs;
    const auto add = [&runs](nbody::ForceMethod method, double theta, double timestep,
                             double scale) {
        const DriftRun run{method, method == nbody::ForceMethod::tree ? theta : 0.0, timestep,
                           scale};
        const auto same = [&run](const DriftRun& other) {
            return other.method == run.method && other.theta == run.theta &&
                   other.timestep == run.timestep && other.softening_scale == run.softening_scale;
        };
        if (std::ranges::none_of(runs, same)) {
            runs.push_back(run);
        }
    };
    for (const auto method : {nbody::ForceMethod::tree, nbody::ForceMethod::direct}) {
        for (const double theta : {0.3, 0.5, 0.7, 1.0}) {
            add(method, theta, REFERENCE_TIMESTEP, REFERENCE_SOFTENING_SCALE);
        }
        for (const double timestep : {1.0 / 64.0, 1.0 / 128.0, 1.0 / 256.0}) {
            add(method, REFERENCE_THETA, timestep, REFERENCE_SOFTENING_SCALE);
        }
        for (const double scale : {1.0, 2.0, 4.0}) {
            add(method, REFERENCE_THETA, REFERENCE_TIMESTEP, scale);
        }
    }
    return runs;
}

double total_energy(const nbody::ParticleSet& particles, double softening, unsigned threads) {
    return nbody::kinetic_energy(particles) +
           nbody::potential_energy(particles, softening, threads);
}

void write_drift_run(std::ostream& out, const DriftRun& run, std::size_t count,
                     double end_time) {
    const double softening = softening_for(count, run.softening_scale);
    const unsigned threads = thread_count();
    nbody::Simulation simulation(
        nbody::plummer_sphere(count, SEED),
        {softening, run.method, run.theta, threads}, run.timestep);
    const auto steps_per_sample = static_cast<std::size_t>(std::llround(SAMPLE_INTERVAL / run.timestep));
    const auto samples = static_cast<std::size_t>(std::floor(end_time / SAMPLE_INTERVAL));
    const double initial_energy = total_energy(simulation.particles(), softening, threads);
    const std::string theta_text =
        run.method == nbody::ForceMethod::tree ? std::format("{}", run.theta) : "";
    const std::string method_text = run.method == nbody::ForceMethod::tree ? "tree" : "direct";
    for (std::size_t sample = 0; sample <= samples; ++sample) {
        if (sample > 0) {
            simulation.step(steps_per_sample);
        }
        const double energy = total_energy(simulation.particles(), softening, threads);
        out << std::format("{},{},{},{},{},{:.6e}\n", method_text, theta_text, run.timestep,
                           run.softening_scale, simulation.time(),
                           std::abs(energy - initial_energy) / std::abs(initial_energy));
    }
}

void write_drift(std::ostream& out, std::size_t count, double end_time) {
    out << "method,theta,timestep,softening_scale,time,relative_energy_error\n";
    for (const DriftRun& run : drift_runs()) {
        write_drift_run(out, run, count, end_time);
    }
}

int run(const std::vector<std::string>& arguments) {
    const std::string usage =
        "usage: accuracy_sweep force <output.csv> [count]\n"
        "       accuracy_sweep drift <output.csv> [count] [end_time]";
    if (arguments.size() < 2 || (arguments[0] != "force" && arguments[0] != "drift") ||
        arguments.size() > (arguments[0] == "force" ? 3U : 4U)) {
        std::cerr << usage << '\n';
        return 2;
    }
    const bool is_force = arguments[0] == "force";
    const std::size_t count =
        arguments.size() > 2
            ? parse_count(arguments[2])
            : (is_force ? DEFAULT_FORCE_COUNT : DEFAULT_DRIFT_COUNT);
    const double end_time = arguments.size() > 3 ? parse_end_time(arguments[3]) : DEFAULT_END_TIME;
    std::ofstream out(arguments[1]);
    if (!out) {
        std::cerr << "cannot open " << arguments[1] << " for writing\n";
        return 1;
    }
    if (is_force) {
        write_force_error(out, count);
    } else {
        write_drift(out, count, end_time);
    }
    out.close();
    if (!out) {
        std::cerr << "failed writing " << arguments[1] << '\n';
        return 1;
    }
    return 0;
}

}  // namespace

int main(int argc, char** argv) {
    try {
        const std::span<char*> all(argv, static_cast<std::size_t>(argc));
        return run(std::vector<std::string>(all.begin() + 1, all.end()));
    } catch (const std::exception& error) {
        std::cerr << "accuracy_sweep: " << error.what() << '\n';
        return 1;
    }
}
