// The browser surface of the library: one Simulation class, built by a static
// factory, stepped in batches and read through typed-array views of the heap.
// Every failure reaches JavaScript as an Error whose message names the value.

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <stdexcept>
#include <string>
#include <utility>

#include "nbody/diagnostics.hpp"
#include "nbody/forces.hpp"
#include "nbody/particles.hpp"
#include "nbody/setups.hpp"
#include "nbody/simulation.hpp"

namespace {

// The heap is fixed at build time (256 MiB), and a tree evaluation at this
// count needs well under half of it.
constexpr std::size_t MAX_BROWSER_PARTICLES = 65536;

// Threads the build can run: the size of the preallocated worker pool in the
// threaded build, one in the single-threaded build.
constexpr unsigned MAX_BROWSER_THREADS = NBODY_WASM_MAX_THREADS;

// Bounds one call: a step at the largest count takes about 0.6 s on one thread.
constexpr std::size_t MAX_STEPS_PER_CALL = 1024;

// Eccentricity and semi-major axis of the Kepler setup.
constexpr double KEPLER_ECCENTRICITY = 0.5;
constexpr double KEPLER_SEMI_MAJOR_AXIS = 1.0;

// JavaScript numbers reach Embind as doubles, and Embind would truncate or wrap
// them into an integer type before any check, so integers are read as doubles.
std::size_t whole_number(const char* what, double value, std::size_t lowest,
                         std::size_t highest) {
    if (!(value >= static_cast<double>(lowest) && value <= static_cast<double>(highest)) ||
        value != std::floor(value)) {
        throw std::invalid_argument(std::string(what) + " must be a whole number from " +
                                    std::to_string(lowest) + " to " + std::to_string(highest) +
                                    ", got " + std::to_string(value));
    }
    return static_cast<std::size_t>(value);
}

nbody::ForceMethod parse_method(const std::string& name) {
    if (name == "direct") {
        return nbody::ForceMethod::direct;
    }
    if (name == "tree") {
        return nbody::ForceMethod::tree;
    }
    throw std::invalid_argument(R"(method must be "direct" or "tree", got ")" + name + "\"");
}

nbody::ParticleSet make_particles(const std::string& setup, double count,
                                  std::uint32_t seed) {
    if (setup == "kepler") {
        return nbody::kepler_binary(KEPLER_ECCENTRICITY, KEPLER_SEMI_MAJOR_AXIS);
    }
    if (setup != "plummer" && setup != "collapse") {
        throw std::invalid_argument(
            R"(setup must be "plummer", "collapse" or "kepler", got ")" + setup + "\"");
    }
    const std::size_t particle_count = whole_number("count", count, 1, MAX_BROWSER_PARTICLES);
    return setup == "plummer" ? nbody::plummer_sphere(particle_count, seed)
                              : nbody::uniform_sphere(particle_count, seed);
}

emscripten::val view_of(std::span<const nbody::Vec3> vectors) {
    static_assert(sizeof(nbody::Vec3) == 3 * sizeof(double));
    const void* first = vectors.data();
    return emscripten::val(
        emscripten::typed_memory_view(3 * vectors.size(), static_cast<const double*>(first)));
}

// Runs an operation and turns a standard exception into a JavaScript Error.
template <typename Operation>
auto rethrow_as_js_error(Operation&& operation) -> decltype(operation()) {
    try {
        return std::forward<Operation>(operation)();
    } catch (const std::exception& error) {
        emscripten::val::global("Error").new_(std::string(error.what())).throw_();
    }
}

class Simulation {
public:
    // Throws an Error for an unknown setup or method, a count outside 1 to
    // MAX_BROWSER_PARTICLES, a thread count outside 1 to the build's limit, or
    // any value the core rejects.
    static Simulation create(const std::string& setup, double count, double seed,
                             const std::string& method, double theta, double softening,
                             double timestep, double threads) {
        return rethrow_as_js_error([&] {
            const auto thread_count = static_cast<unsigned>(
                whole_number("threads", threads, 1, MAX_BROWSER_THREADS));
            const auto seed_value = static_cast<std::uint32_t>(
                whole_number("seed", seed, 0, std::numeric_limits<std::uint32_t>::max()));
            const nbody::ForceConfig config{.softening = softening,
                                            .method = parse_method(method),
                                            .theta = theta,
                                            .thread_count = thread_count};
            return Simulation(make_particles(setup, count, seed_value), config, timestep);
        });
    }

    // Throws an Error unless count is from 1 to MAX_STEPS_PER_CALL, or when a
    // position or velocity becomes non-finite.
    void step(double count) {
        rethrow_as_js_error([&] {
            simulation_.step(whole_number("steps", count, 1, MAX_STEPS_PER_CALL));
        });
    }

    [[nodiscard]] std::size_t size() const { return simulation_.particles().size(); }
    [[nodiscard]] double time() const { return simulation_.time(); }
    [[nodiscard]] emscripten::val positions() const { return view_of(simulation_.particles().positions()); }
    [[nodiscard]] emscripten::val velocities() const { return view_of(simulation_.particles().velocities()); }

    // Kinetic plus the softened direct potential, whatever the force method.
    [[nodiscard]] double energy() const { return total_energy(simulation_); }
    [[nodiscard]] double initial_energy() const { return initial_energy_; }

private:
    Simulation(nbody::ParticleSet particles, const nbody::ForceConfig& config, double timestep)
        : simulation_(std::move(particles), config, timestep),
          initial_energy_(total_energy(simulation_)) {}

    static double total_energy(const nbody::Simulation& simulation) {
        return nbody::kinetic_energy(simulation.particles()) +
               nbody::potential_energy(simulation.particles(), simulation.config().softening,
                                       simulation.config().thread_count);
    }

    nbody::Simulation simulation_;
    double initial_energy_;
};

}  // namespace

EMSCRIPTEN_BINDINGS(nbody) {
    emscripten::constant("MAX_PARTICLES", MAX_BROWSER_PARTICLES);
    emscripten::constant("MAX_THREADS", MAX_BROWSER_THREADS);
    emscripten::constant("MAX_STEPS_PER_CALL", MAX_STEPS_PER_CALL);

    emscripten::class_<Simulation>("Simulation")
        .class_function("create", &Simulation::create)
        .function("step", &Simulation::step)
        .function("size", &Simulation::size)
        .function("time", &Simulation::time)
        .function("positions", &Simulation::positions)
        .function("velocities", &Simulation::velocities)
        .function("energy", &Simulation::energy)
        .function("initialEnergy", &Simulation::initial_energy);
}
