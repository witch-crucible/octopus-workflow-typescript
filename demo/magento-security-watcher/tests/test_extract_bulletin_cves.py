from magento_security_watcher.sources import extract_bulletin_cves


def test_extract_bulletin_cves_prefers_vuln_details():
    html = """
    <html><body>
    <p>Related: CVE-2024-99999 in chrome</p>
    <h2>Vulnerability Details</h2>
    <table><tr><td>CVE-2020-3715</td></tr><tr><td>CVE-2020-3716</td></tr></table>
    <h2>Acknowledgments</h2>
    <p>Thanks CVE-2019-0001</p>
    </body></html>
    """
    assert extract_bulletin_cves(html) == ["CVE-2020-3715", "CVE-2020-3716"]
