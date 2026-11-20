import gc
import sys

import numpy as np
import pytest

import barnes_hut as bh

SOFTENING = 0.125
TIMESTEP = 1 / 128


def make_simulation(
    count: int = 256,
    *,
    method: str = "tree",
    theta: float = 0.5,
    threads: int = 1,
) -> bh.Simulation:
    positions, velocities, masses = bh.plummer_sphere(count, seed=1)
    return bh.Simulation(
        positions,
        velocities,
        masses,
        dt=TIMESTEP,
        softening=SOFTENING,
        method=method,
        theta=theta,
        threads=threads,
    )


def test_plummer_sphere_returns_float64_arrays_with_unit_total_mass() -> None:
    positions, velocities, masses = bh.plummer_sphere(1024, seed=1)
    assert positions.shape == velocities.shape == (1024, 3)
    assert masses.shape == (1024,)
    assert {positions.dtype, velocities.dtype, masses.dtype} == {np.dtype("float64")}
    assert abs(masses.sum() - 1.0) < 1e-12


def test_plummer_sphere_repeats_for_one_seed_and_differs_for_another() -> None:
    first = bh.plummer_sphere(64, seed=3)[0]
    assert np.array_equal(first, bh.plummer_sphere(64, seed=3)[0])
    assert not np.array_equal(first, bh.plummer_sphere(64, seed=4)[0])


def test_uniform_sphere_starts_at_rest() -> None:
    positions, velocities, masses = bh.uniform_sphere(100, seed=2)
    assert positions.shape == (100, 3)
    assert not velocities.any()
    assert abs(masses.sum() - 1.0) < 1e-12


def test_kepler_binary_has_two_bodies_and_rejects_eccentricity_one() -> None:
    positions, _, masses = bh.kepler_binary(0.5, 1.0)
    assert positions.shape == (2, 3)
    assert masses.sum() == pytest.approx(1.0)
    with pytest.raises(ValueError, match=r"eccentricity.*1"):
        bh.kepler_binary(1.0, 1.0)


def test_setups_return_empty_arrays_for_zero_particles() -> None:
    positions, velocities, masses = bh.plummer_sphere(0, seed=1)
    assert positions.shape == velocities.shape == (0, 3)
    assert masses.shape == (0,)


def test_tree_simulation_conserves_energy_over_64_steps() -> None:
    simulation = make_simulation(1024, method="tree", theta=0.5)
    initial_energy = simulation.total_energy()
    simulation.step(64)
    assert simulation.time == pytest.approx(0.5)
    assert abs(simulation.total_energy() - initial_energy) / abs(initial_energy) < 1e-3


def test_step_defaults_to_one_step() -> None:
    simulation = make_simulation(16)
    simulation.step()
    assert simulation.time == TIMESTEP


def test_direct_simulation_conserves_energy() -> None:
    simulation = make_simulation(128, method="direct")
    initial_energy = simulation.total_energy()
    simulation.step(100)
    assert abs(simulation.total_energy() - initial_energy) / abs(initial_energy) < 1e-4


def test_energies_add_up_and_potential_is_negative() -> None:
    simulation = make_simulation(128)
    assert simulation.kinetic_energy() > 0
    assert simulation.potential_energy() < 0
    assert simulation.total_energy() == simulation.kinetic_energy() + simulation.potential_energy()


def test_theta_above_one_is_rejected_with_the_value() -> None:
    with pytest.raises(ValueError, match=r"1\.5"):
        make_simulation(theta=1.5)


def test_unknown_method_is_rejected_with_the_value() -> None:
    with pytest.raises(ValueError, match="fast"):
        make_simulation(method="fast")


def test_non_positive_timestep_is_rejected_with_the_value() -> None:
    with pytest.raises(ValueError, match=r"timestep.*got -2"):
        bh.Simulation(*bh.plummer_sphere(8, seed=1), dt=-2.0, softening=SOFTENING)


def test_negative_softening_is_rejected_with_the_value() -> None:
    with pytest.raises(ValueError, match=r"softening.*got -1"):
        bh.Simulation(*bh.plummer_sphere(8, seed=1), dt=TIMESTEP, softening=-1.0)


def test_zero_threads_is_rejected_with_the_value() -> None:
    with pytest.raises(ValueError, match=r"thread count.*got 0"):
        make_simulation(threads=0)


def test_mismatched_array_sizes_are_rejected() -> None:
    positions, velocities, masses = bh.plummer_sphere(8, seed=1)
    with pytest.raises(ValueError, match=r"equal sizes.*8, 8 and 4"):
        bh.Simulation(positions, velocities, masses[:4], dt=TIMESTEP, softening=SOFTENING)


def test_wrong_array_shape_is_a_type_error() -> None:
    positions, velocities, masses = bh.plummer_sphere(8, seed=1)
    with pytest.raises(TypeError):
        bh.Simulation(positions[:, :2], velocities, masses, dt=TIMESTEP, softening=SOFTENING)


def test_negative_step_count_is_a_type_error() -> None:
    with pytest.raises(TypeError):
        make_simulation(8).step(-1)


def test_positions_are_a_read_only_view_that_follows_the_state() -> None:
    simulation = make_simulation(64)
    positions = simulation.positions
    before = positions.copy()
    with pytest.raises(ValueError, match="read-only"):
        positions[0, 0] = 0.0
    simulation.step(4)
    assert not np.array_equal(positions, before)
    assert np.shares_memory(positions, simulation.positions)


@pytest.mark.parametrize("name", ["velocities", "masses"])
def test_velocities_and_masses_are_read_only(name: str) -> None:
    view = getattr(make_simulation(8), name)
    with pytest.raises(ValueError, match="read-only"):
        view[0] = 0.0


def test_a_view_keeps_the_simulation_alive() -> None:
    simulation = make_simulation(64)
    references_before = sys.getrefcount(simulation)
    views = (simulation.positions, simulation.velocities, simulation.masses)
    assert sys.getrefcount(simulation) == references_before + len(views)
    del views
    gc.collect()
    assert sys.getrefcount(simulation) == references_before


def test_simulation_copies_its_inputs() -> None:
    positions, velocities, masses = bh.plummer_sphere(16, seed=1)
    simulation = bh.Simulation(positions, velocities, masses, dt=TIMESTEP, softening=SOFTENING)
    expected = positions.copy()
    positions[:] = 0.0
    assert np.array_equal(simulation.positions, expected)


def test_results_are_identical_for_every_thread_count() -> None:
    one, four = make_simulation(512, threads=1), make_simulation(512, threads=4)
    one.step(8)
    four.step(8)
    assert np.array_equal(one.positions, four.positions)


def test_empty_simulation_does_nothing() -> None:
    positions, velocities, masses = bh.plummer_sphere(0, seed=1)
    simulation = bh.Simulation(positions, velocities, masses, dt=TIMESTEP, softening=SOFTENING)
    simulation.step(3)
    assert simulation.positions.shape == (0, 3)
    assert simulation.total_energy() == 0.0


def test_overflowing_state_raises_runtime_error() -> None:
    positions, velocities, masses = bh.kepler_binary(0.5, 1.0)
    simulation = bh.Simulation(
        positions, velocities, masses * 1e308, dt=10.0, softening=0.0, method="direct"
    )
    with pytest.raises(RuntimeError, match="particle"):
        simulation.step(5)
