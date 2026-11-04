#include "fixture_identity.hpp"

QString fixtureIdentity(const QString &component) {
    return QStringLiteral("ci-workflows/%1").arg(component.trimmed().toLower());
}
