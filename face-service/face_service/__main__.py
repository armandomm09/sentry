"""Entrypoint: `python -m face_service`."""

from __future__ import annotations

import logging
import os

from aiohttp import web

from .config import Config
from .server import make_app


def main() -> None:
    logging.basicConfig(
        level=os.environ.get("FACE_SERVICE_LOG_LEVEL", "INFO"),
        format="%(asctime)s [face-service] %(levelname)s %(name)s %(message)s",
    )
    config = Config.from_env()
    config.data_dir.mkdir(parents=True, exist_ok=True)
    logging.info(
        "starting face-service host=%s port=%d data=%s model=%s",
        config.host, config.port, config.data_dir, config.model_pack,
    )
    app = make_app(config)
    web.run_app(app, host=config.host, port=config.port, print=lambda *_: None)


if __name__ == "__main__":
    main()
