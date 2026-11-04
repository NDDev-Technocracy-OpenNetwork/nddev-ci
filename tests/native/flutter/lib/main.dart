import 'package:flutter/material.dart';

import 'l10n/app_localizations.dart';

void main() => runApp(const FixtureApp());

class FixtureApp extends StatelessWidget {
  const FixtureApp({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: FixtureHome(),
    );
  }
}

class FixtureHome extends StatelessWidget {
  const FixtureHome({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(child: Text(AppLocalizations.of(context)!.greeting)),
    );
  }
}
