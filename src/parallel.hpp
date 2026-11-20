#pragma once

#include <cstddef>

namespace nbody {

// Consecutive indices handed to a thread at a time: large enough to keep
// scheduling cheap, small enough that uneven work (a triangular pair sum, a
// tree walk through a dense core) still balances.
constexpr std::ptrdiff_t SCHEDULE_CHUNK = 16;

// Calls body(i) for every i below count, on thread_count threads (at least 1).
// Calls for different indices run concurrently, so each must write only
// storage that no other index writes, and none may throw.
template <typename Body>
void parallel_for(std::size_t count, unsigned thread_count, const Body& body) {
    const auto signed_count = static_cast<std::ptrdiff_t>(count);
#pragma omp parallel for num_threads(thread_count) schedule(dynamic, SCHEDULE_CHUNK)
    for (std::ptrdiff_t i = 0; i < signed_count; ++i) {
        body(static_cast<std::size_t>(i));
    }
}

}  // namespace nbody
