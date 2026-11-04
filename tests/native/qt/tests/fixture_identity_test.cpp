#include "fixture_identity.hpp"

#include <QTest>

class FixtureIdentityTest final : public QObject {
    Q_OBJECT

private slots:
    void normalizesComponentName() {
        QCOMPARE(
            fixtureIdentity(QStringLiteral("  Qt-Core  ")),
            QStringLiteral("ci-workflows/qt-core"));
    }
};

QTEST_MAIN(FixtureIdentityTest)

#include "fixture_identity_test.moc"
