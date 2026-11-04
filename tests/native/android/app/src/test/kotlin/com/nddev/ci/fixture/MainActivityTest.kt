package com.nddev.ci.fixture

import org.junit.Assert.assertEquals
import org.junit.Test

class MainActivityTest {
    @Test
    fun fixtureIdentityIsStable() {
        assertEquals("ci-workflows fixture", fixtureMessage())
    }
}
