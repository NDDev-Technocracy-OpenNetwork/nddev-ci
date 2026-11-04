pub fn is_even(value: u32) -> bool {
    value % 2 == 0
}
#[test]
fn selected_values() {
    assert!(is_even(0));
    assert!(is_even(2));
    assert!(!is_even(1));
    assert!(!is_even(3));
    assert!(!is_even(u32::MAX));
}
