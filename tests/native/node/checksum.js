/** Sum UTF-8 bytes modulo 256.
 * @param {string} text
 * @returns {number}
 */
export function checksum(text) {
  return new TextEncoder()
    .encode(text)
    .reduce((sum, value) => (sum + value) % 256, 0);
}
