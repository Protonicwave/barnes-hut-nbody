# barnes-hut-nbody

A gravitational N-body simulator in C++20 that uses a Barnes-Hut octree, runs its force loops on threads, and is called from Python through NumPy arrays. The same core compiles to WebAssembly and runs live at https://barnes-hut-nbody.pages.dev/.

## Method

Every particle attracts every other under Newtonian gravity with Plummer softening, in units where the gravitational constant is 1. The acceleration of a particle is the sum, over every other particle, of that particle's mass times the vector towards it, divided by the softened distance cubed. The softened distance squared is the true distance squared plus the softening length squared.

Summing every pair costs a number of terms that grows as the square of the particle count. The tree method groups distant particles. Particles are placed in an octree, and a cell is used as one source of mass at its centre of mass when it is far enough away for its size. The opening angle sets that threshold: 0 opens every cell and reproduces the direct sum, and values above about 0.7 are not recommended. For a bounded, roughly uniform distribution the expected cost grows as the particle count times its logarithm.

Time stepping is kick-drift-kick leapfrog with a fixed timestep: a half kick of the velocities, a full drift of the positions, then a second half kick. The scheme is symplectic and second order. The total energy is the kinetic energy plus the softened pairwise potential energy, which is negative, and the potential is always summed directly, so the tree's error is measured against an exact reference.

## Results

On an Intel Core Ultra 5 238V with 8 threads and an opening angle of 0.5, the tree is faster than direct summation from 2048 particles and 10.8 times faster at 65536. At 16384 particles the median relative force error against direct summation is 1.0e-3 at an opening angle of 0.5. The full tables and figures are in the repository.

## Quick start

```
pip install git+https://github.com/Protonicwave/barnes-hut-nbody
```

```python
import numpy as np
import barnes_hut as bh

positions, velocities, masses = bh.plummer_sphere(4096, seed=1)
simulation = bh.Simulation(
    positions, velocities, masses,
    dt=1 / 128, softening=4 / np.sqrt(4096),
    method="tree", theta=0.5, threads=8,
)
start = simulation.total_energy()
simulation.step(256)
print(simulation.time, abs(simulation.total_energy() - start) / abs(start))
```

## Links

- Live simulator: https://barnes-hut-nbody.pages.dev/
- Source, equations and results: https://github.com/Protonicwave/barnes-hut-nbody
- Build and reproduction guides: https://github.com/Protonicwave/barnes-hut-nbody/tree/main/docs

## Licence

MIT.
