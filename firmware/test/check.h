#ifndef SAMPLE_BOX_TEST_CHECK_H
#define SAMPLE_BOX_TEST_CHECK_H

#include <stdio.h>

extern int g_checks;
extern int g_failed;

#define EXPECT(cond)                                                                 \
    do {                                                                             \
        g_checks++;                                                                  \
        if (!(cond)) {                                                               \
            fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);         \
            g_failed++;                                                              \
        }                                                                            \
    } while (0)

#define EXPECT_EQ(got, want)                                                         \
    do {                                                                             \
        long long _got = (long long)(got);                                          \
        long long _want = (long long)(want);                                        \
        g_checks++;                                                                  \
        if (_got != _want) {                                                         \
            fprintf(stderr, "FAIL %s:%d: %s=%lld want %lld\n", __FILE__, __LINE__, #got, \
                    _got, _want);                                                    \
            g_failed++;                                                              \
        }                                                                            \
    } while (0)

#endif
