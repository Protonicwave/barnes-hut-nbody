#include <nanobind/nanobind.h>
#include <nanobind/ndarray.h>
#include <nanobind/stl/string.h>
#include <nanobind/stl/tuple.h>

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <initializer_list>
#include <span>
#include <stdexcept>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

#include "nbody/diagnostics.hpp"
#include "nbody/forces.hpp"
#include "nbody/particles.hpp"
#include "nbody/setups.hpp"
#include "nbody/simulation.hpp"

namespace nb = nanobind;

namespace {

using Vectors = nb::ndarray<const double, nb::shape<-1, 3>, nb::c_contig, nb::device::cpu>;
using Scalars = nb::ndarray<const double, nb::shape<-1>, nb::c_contig, nb::device::cpu>;
using VectorView = nb::ndarray<nb::numpy, const double, nb::shape<-1, 3>>;
using ScalarView = nb::ndarray<nb::numpy, const double, nb::shape<-1>>;

std::vector<nbody::Vec3> to_vec3s(const Vectors& array) {
    std::vector<nbody::Vec3> result;
    result.reserve(array.shape(0));
    const double* values = array.data();
    for (std::size_t i = 0; i < array.shape(0); ++i) {
        result.push_back({values[3 * i], values[3 * i + 1], values[3 * i + 2]});
    }
    return result;
}

nbody::ForceMethod parse_method(const std::string& name) {
    if (name == "direct") {
        return nbody::ForceMethod::direct;
    }
    if (name == "tree") {
        return nbody::ForceMethod::tree;
    }
    throw std::invalid_argument("method must be \"direct\" or \"tree\", got \"" + name + "\"");
}

// A numpy array that owns the values and frees them with the array.
template <typename Shape>
nb::ndarray<nb::numpy, double, Shape> owned(std::vector<double>&& values,
                                            std::initializer_list<std::size_t> shape) {
    auto* storage = new std::vector<double>(std::move(values));
    const nb::capsule owner(storage, [](void* pointer) noexcept {
        delete static_cast<std::vector<double>*>(pointer);
    });
    return {storage->data(), shape, owner};
}

std::vector<double> flatten(std::span<const nbody::Vec3> vectors) {
    std::vector<double> flat;
    flat.reserve(3 * vectors.size());
    for (const nbody::Vec3& vector : vectors) {
        flat.insert(flat.end(), {vector.x, vector.y, vector.z});
    }
    return flat;
}

using VectorArray = nb::ndarray<nb::numpy, double, nb::shape<-1, 3>>;
using ScalarArray = nb::ndarray<nb::numpy, double, nb::shape<-1>>;

std::tuple<VectorArray, VectorArray, ScalarArray> to_arrays(const nbody::ParticleSet& particles) {
    const std::size_t count = particles.size();
    return {owned<nb::shape<-1, 3>>(flatten(particles.positions()), {count, 3}),
            owned<nb::shape<-1, 3>>(flatten(particles.velocities()), {count, 3}),
            owned<nb::shape<-1>>({particles.masses().begin(), particles.masses().end()}, {count})};
}

const double* data_of(std::span<const nbody::Vec3> vectors) {
    return reinterpret_cast<const double*>(vectors.data());
}

double potential_energy_of(const nbody::Simulation& simulation) {
    return nbody::potential_energy(simulation.particles(), simulation.config().softening,
                                   simulation.config().thread_count);
}

}  // namespace

NB_MODULE(_core, module) {
    module.doc() = "Barnes-Hut gravitational N-body simulation in N-body units, G = 1.";

    module.def("plummer_sphere", [](std::size_t count, std::uint64_t seed) {
        return to_arrays(nbody::plummer_sphere(count, seed));
    }, nb::arg("count"), nb::arg("seed"));

    module.def("uniform_sphere", [](std::size_t count, std::uint64_t seed) {
        return to_arrays(nbody::uniform_sphere(count, seed));
    }, nb::arg("count"), nb::arg("seed"));

    module.def("kepler_binary", [](double eccentricity, double semi_major_axis) {
        return to_arrays(nbody::kepler_binary(eccentricity, semi_major_axis));
    }, nb::arg("eccentricity"), nb::arg("semi_major_axis"));

    nb::class_<nbody::Simulation>(
        module, "Simulation",
        "Leapfrog simulation of N bodies. Arguments are float64 arrays of shape (N, 3), (N, 3) "
        "and (N,), copied on construction. Invalid settings raise ValueError naming the value; "
        "step raises RuntimeError if a position or velocity becomes non-finite. step holds the "
        "interpreter lock and cannot be interrupted. Not safe to share between threads.")
        .def("__init__", [](nbody::Simulation* self, const Vectors& positions,
                            const Vectors& velocities, const Scalars& masses, double dt,
                            double softening, const std::string& method, double theta,
                            unsigned threads) {
                 const nbody::ForceConfig config{.softening = softening,
                                                 .method = parse_method(method),
                                                 .theta = theta,
                                                 .thread_count = threads};
                 new (self) nbody::Simulation(
                     nbody::ParticleSet(to_vec3s(positions), to_vec3s(velocities),
                                        std::vector<double>(masses.data(),
                                                            masses.data() + masses.shape(0))),
                     config, dt);
             },
             nb::arg("positions"), nb::arg("velocities"), nb::arg("masses"), nb::kw_only(),
             nb::arg("dt"), nb::arg("softening"), nb::arg("method") = "tree",
             nb::arg("theta") = 0.5, nb::arg("threads") = 1)
        .def("step", &nbody::Simulation::step, nb::arg("count") = 1)
        .def_prop_ro("time", &nbody::Simulation::time)
        .def_prop_ro("positions", [](const nbody::Simulation& self) {
            const auto positions = self.particles().positions();
            return VectorView(data_of(positions), {positions.size(), 3}, nb::find(&self));
        })
        .def_prop_ro("velocities", [](const nbody::Simulation& self) {
            const auto velocities = self.particles().velocities();
            return VectorView(data_of(velocities), {velocities.size(), 3}, nb::find(&self));
        })
        .def_prop_ro("masses", [](const nbody::Simulation& self) {
            const auto masses = self.particles().masses();
            return ScalarView(masses.data(), {masses.size()}, nb::find(&self));
        })
        .def("kinetic_energy", [](const nbody::Simulation& self) {
            return nbody::kinetic_energy(self.particles());
        })
        .def("potential_energy", &potential_energy_of)
        .def("total_energy", [](const nbody::Simulation& self) {
            return nbody::kinetic_energy(self.particles()) + potential_energy_of(self);
        });
}
