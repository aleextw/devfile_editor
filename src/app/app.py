from litestar import Litestar
from litestar.contrib.jinja import JinjaTemplateEngine
from litestar.template.config import TemplateConfig
from litestar.static_files import StaticFilesConfig
from app.core.config import settings
from app.controller.devfile import DevfileController

app = Litestar(
    route_handlers=[DevfileController],
    template_config=TemplateConfig(
        directory=settings.template_dir,
        engine=JinjaTemplateEngine,
    ),
    static_files_config=[
        StaticFilesConfig(
            directories=[settings.static_dir],
            path="/static",
        ),
    ],
)
