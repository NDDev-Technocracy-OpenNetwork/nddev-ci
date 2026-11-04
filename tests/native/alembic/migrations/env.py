from alembic import context
from sqlalchemy import create_engine

engine = create_engine(context.config.get_main_option("sqlalchemy.url"))
with engine.connect() as connection:
    context.configure(connection=connection)
    with context.begin_transaction():
        context.run_migrations()
