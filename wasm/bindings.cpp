// The browser surface of the library: one Simulation class, built by a static
// factory, stepped in batches and read through typed-array views of the heap.
// Every failure reaches JavaScript as an Error whose message names the value.

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <cstddef>
#include <cstdint>
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

// Keeps one call short enough that the worker can still answer messages.
constexpr std::size_t MAX_STEPS_PER_CALL = 1024;

// Eccentricity and semi-major axis of the Kepler setup.
constexpr double KEPLER_ECCENTRICITY = 0.5;
constexpr double KEPLER_SEMI_MAJOR_AXIS = 1.0;

std::string describe_limits(const char* what, std::size_t lowest, std::size_t highest,
                            std::size_t got) {
    return std::string(what) + " must be from " + std::to_string(lowest) + " to " +
           std::to_string(highest) + ", got " + std::to_string(got);
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

nbody::ParticleSet make_particles(const std::string& setup, std::size_t count,
                                  std::uint32_t seed) {
    if (setup == "kepler") {
        return nbody::kepler_binary(KEPLER_ECCENTRICITY, KEPLER_SEMI_MAJOR_AXIS);
    }
    if (setup != "plummer" && setup != "collapse") {
        throw std::invalid_argument(
            R"(setup must be "plummer", "collapse" or "kepler", got ")" + setup + "\"");
    }
    if (count < 1 || count > MAX_BROWSER_PARTICLES) {
        throw std::invalid_argument(describe_limits("count", 1, MAX_BROWSER_PARTICLES, count));
    }
    return setup == "plummer" ? nbody::plummer_sphere(count, seed)
                              : nbody::uniform_sphere(count, seed);
}

emscripten::val view_of(std::span<const nbody::Vec3> vectors) {
    static_assert(sizeof(nbody::Vec3) == 3 * sizeof(double));
    const void* first = vectors.data();
    return emscripten::val(
        emscripten::typed_memory_view(3 * vectors.size(), static_cast<const double*>(first)));
}

// Runs an operation and turns a standard exception into a JavaScript Error.
template <typename Operation>
auto as_js_error(Operation&& operation) -> decltype(operation()) {
    try {
        return std::forward<Operation>(operation)();
    } catch (const std::exception& error) {
        emscripten::val::global("Error").new_(std::string(error.what())).throw_();
        throw;  // throw_ does not return; this keeps the compiler's flow analysis honest
    }
}

class Simulation {
public:
    // Throws an Error for an unknown setup or method, a count outside 1 to
    // MAX_BROWSER_PARTICLES, a thread count outside 1 to the build's limit, or
    // any value the core rejects.
    static Simulation create(const std::string& setup, std::size_t count, std::uint32_t seed,
                             const std::string& method, double theta, double softening,
                             double timestep, unsigned threads) {
        return as_js_error([&] {
            if (threads < 1 || threads > MAX_BROWSER_THREADS) {
                throw std::invalid_argument(
                    describe_limits("threads", 1, MAX_BROWSER_THREADS, threads));
            }
            const nbody::ForceConfig config{.softening = softening,
                                            .method = parse_method(method),
                                            .theta = theta,
                                            .thread_count = threads};
            return Simulation(make_particles(setup, count, seed), config, timestep);
        });
    }

    // Throws an Error unless count is from 1 to MAX_STEPS_PER_CALL, or when a
    // position or velocity becomes non-finite.
    void step(std::size_t count) {
        as_js_error([&] {
            if (count < 1 || count > MAX_STEPS_PER_CALL) {
                throw std::invalid_argument(describe_limits("steps", 1, MAX_STEPS_PER_CALL, count));
            }
            simulation_.step(count);
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
