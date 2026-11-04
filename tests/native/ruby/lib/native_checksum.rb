# frozen_string_literal: true

# Finite byte checksum shared by the native fixture's behavioral checks.
module NativeChecksum
  def self.checksum(value)
    value.bytes.sum % 256
  end
end
