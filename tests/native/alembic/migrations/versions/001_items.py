import sqlalchemy as sa
from alembic import op

revision = "001"
down_revision = None


def upgrade():
    op.create_table("items", sa.Column("id", sa.Integer, primary_key=True))
