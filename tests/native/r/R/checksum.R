#' Sum the bytes of a string modulo 256.
#'
#' Trivial on purpose: this fixture exists to make the workflow run, not to
#' test arithmetic.
#'
#' @param text A length-one character vector.
#' @return An integer in [0, 255].
#' @export
checksum <- function(text) {
  if (nchar(text) == 0L) {
    return(0L)
  }
  sum(as.integer(charToRaw(text))) %% 256L
}
