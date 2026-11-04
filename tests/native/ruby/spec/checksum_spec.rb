# frozen_string_literal: true

require_relative '../lib/native_checksum'

RSpec.describe NativeChecksum do
  it 'computes the known empty and ASCII payloads' do
    expect(described_class.checksum('ci')).to eq(204)
    expect(described_class.checksum('')).to eq(0)
  end

  it 'keeps byte sums in the declared modular range' do
    ['', 'a', 'the quick brown fox'].each do |payload|
      expect(described_class.checksum(payload)).to be_between(0, 255)
    end
  end
end
