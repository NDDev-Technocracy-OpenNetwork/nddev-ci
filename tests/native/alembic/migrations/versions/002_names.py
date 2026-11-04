import sqlalchemy as sa
from alembic import op

revision = "002"
down_revision = "001"


def upgrade():
    op.add_column("items", sa.Column("name", sa.String, nullable=True))
