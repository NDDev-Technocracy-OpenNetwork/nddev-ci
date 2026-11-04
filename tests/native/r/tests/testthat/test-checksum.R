test_that("checksum is stable", {
  expect_equal(checksum("ci"), 204L)
  expect_equal(checksum(""), 0L)
})

test_that("checksum stays in one byte", {
  for (sample in c("", "a", "the quick brown fox")) {
    expect_gte(checksum(sample), 0L)
    expect_lte(checksum(sample), 255L)
  }
})
