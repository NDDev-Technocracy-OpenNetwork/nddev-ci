import 'package:ci_workflows_flutter_fixture/main.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('renders the fixture identity', (WidgetTester tester) async {
    await tester.pumpWidget(const FixtureApp());
    await tester.pumpAndSettle();
    expect(find.text('ci-workflows fixture'), findsOneWidget);
  });
}
