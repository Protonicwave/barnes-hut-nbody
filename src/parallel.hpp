#pragma once

#include <cstddef>

#if defined(NBODY_BACKEND_THREADS)
#include <algorithm>
#include <atomic>
#include <thread>
#include <vector>
#endif

namespace nbody {

// Consecutive indices handed to a thread at a time: large enough to keep
// scheduling cheap, small enough that uneven work (a triangular pair sum, a
// tree walk through a dense core) still balances.
constexpr std::ptrdiff_t SCHEDULE_CHUNK = 16;

// Calls body(i) for every i below count, on thread_count threads (at least 1).
// Calls for different indices run concurrently, so each must write only
// storage that no other index writes. An exception leaving body ends the
// program, as it cannot cross the parallel region.
//
// The backend is fixed at build time: OpenMP by default, std::thread when
// NBODY_BACKEND_THREADS is defined (WebAssembly has no OpenMP runtime), and a
// plain loop on the calling thread when NBODY_BACKEND_SERIAL is defined, which
// ignores thread_count. Each index has one owner in every backend, so results
// do not depend on the backend.
#if defined(NBODY_BACKEND_THREADS)

// A thread that cannot be started ends the program: the WebAssembly module
// preallocates the workers its bindings allow, so the case does not arise.
template <typename Body>
void parallel_for(std::size_t count, unsigned thread_count, const Body& body) {
    const auto chunk = static_cast<std::size_t>(SCHEDULE_CHUNK);
    std::atomic<std::size_t> next_index{0};
    const auto drain = [&] {
        for (;;) {
            const std::size_t first = next_index.fetch_add(chunk, std::memory_order_relaxed);
            if (first >= count) {
                return;
            }
            const std::size_t last = std::min(first + chunk, count);
            for (std::size_t i = first; i < last; ++i) {
                body(i);
            }
        }
    };

    const std::size_t chunk_count = (count + chunk - 1) / chunk;
    const std::size_t total_threads = std::min<std::size_t>(thread_count, chunk_count);
    std::vector<std::thread> helpers;
    if (total_threads > 1) {
        helpers.reserve(total_threads - 1);
        for (std::size_t t = 1; t < total_threads; ++t) {
            helpers.emplace_back(drain);
        }
    }
    drain();
    for (std::thread& helper : helpers) {
        helper.join();
    }
}

#elif defined(NBODY_BACKEND_SERIAL)

template <typename Body>
void parallel_for(std::size_t count, unsigned /*thread_count*/, const Body& body) {
    for (std::size_t i = 0; i < count; ++i) {
        body(i);
    }
}

#else

template <typename Body>
void parallel_for(std::size_t count, unsigned thread_count, const Body& body) {
    const auto signed_count = static_cast<std::ptrdiff_t>(count);
#pragma omp parallel for num_threads(thread_count) schedule(dynamic, SCHEDULE_CHUNK)
    for (std::ptrdiff_t i = 0; i < signed_count; ++i) {
        body(static_cast<std::size_t>(i));
    }
}

#endif

}  // namespace nbody
