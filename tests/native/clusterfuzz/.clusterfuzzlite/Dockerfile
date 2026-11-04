FROM gcr.io/oss-fuzz-base/base-builder@sha256:1f9cf74bc3d7029b528494542f9d9851b256dceed38d3f420989434dc5ae0760
COPY . $SRC/native-fixture
WORKDIR $SRC/native-fixture
COPY .clusterfuzzlite/build.sh $SRC/build.sh
